// KanadeTune — Tauri 2 shell.
// Rust-owned network + media paths:
//  1) http_request command — byte-exact HTTP for the InnerTube layer (reqwest).
//  2) `stream` URI scheme — proxies googlevideo audio with the correct client
//     User-Agent. Optionally TRANSCODES AAC -> PCM WAV (symphonia) for
//     machines whose WebView2 lacks the Media Foundation AAC decoder.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .use_rustls_tls()
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .expect("failed to build http client")
    })
}

#[derive(Clone)]
struct StreamEntry {
    url: String,
    ua: String,
    transcode: bool,
}

fn streams() -> &'static Mutex<HashMap<String, StreamEntry>> {
    static S: OnceLock<Mutex<HashMap<String, StreamEntry>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Transcoded WAV cache: id -> wav bytes. Keeps at most 2 entries.
fn wav_cache() -> &'static Mutex<Vec<(String, Arc<Vec<u8>>)>> {
    static S: OnceLock<Mutex<Vec<(String, Arc<Vec<u8>>)>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Vec::new()))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpReq {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body_b64: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HttpResp {
    status: u16,
    headers: Vec<(String, String)>,
    body_b64: String,
    final_url: String,
}

#[tauri::command]
async fn http_request(req: HttpReq) -> Result<HttpResp, String> {
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|e| format!("bad method: {e}"))?;

    let mut r = client().request(method, &req.url);
    for (k, v) in &req.headers {
        r = r.header(k.as_str(), v.as_str());
    }
    if let Some(b64) = &req.body_b64 {
        let bytes = B64.decode(b64).map_err(|e| format!("bad body: {e}"))?;
        r = r.body(bytes);
    }

    let resp = r.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let headers = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = resp
        .bytes()
        .await
        .map_err(|e| format!("body read failed: {e}"))?;

    Ok(HttpResp {
        status,
        headers,
        body_b64: B64.encode(&body),
        final_url,
    })
}

#[tauri::command]
fn register_stream(id: String, url: String, ua: String, transcode: Option<bool>) {
    streams().lock().unwrap().insert(
        id,
        StreamEntry {
            url,
            ua,
            transcode: transcode.unwrap_or(false),
        },
    );
}

// ---------- AAC -> WAV transcoding (symphonia) ----------

fn write_wav_header(out: &mut Vec<u8>, channels: u16, sample_rate: u32, data_len: u32) {
    let byte_rate = sample_rate * channels as u32 * 2;
    let block_align = channels * 2;
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
}

fn decode_aac_to_wav(data: Vec<u8>) -> Result<Vec<u8>, String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let mss = MediaSourceStream::new(Box::new(std::io::Cursor::new(data)), Default::default());
    let mut hint = Hint::new();
    hint.mime_type("audio/mp4");
    hint.with_extension("m4a");

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions {
                enable_gapless: true,
                ..Default::default()
            },
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("probe failed: {e}"))?;

    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| "no default track".to_string())?
        .clone();
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("decoder init failed: {e}"))?;

    let track_id = track.id;
    let mut sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let mut channels: u16 = track
        .codec_params
        .channels
        .map(|c| c.count() as u16)
        .unwrap_or(2);
    let mut pcm: Vec<u8> = Vec::new();
    let mut sbuf: Option<SampleBuffer<i16>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break, // EOF or fatal — stop with what we have
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                sample_rate = spec.rate;
                channels = spec.channels.count() as u16;
                if sbuf.is_none() || sbuf.as_ref().unwrap().capacity() < decoded.capacity() * spec.channels.count() {
                    sbuf = Some(SampleBuffer::<i16>::new(decoded.capacity() as u64, spec));
                }
                let b = sbuf.as_mut().unwrap();
                b.copy_interleaved_ref(decoded);
                for s in b.samples() {
                    pcm.extend_from_slice(&s.to_le_bytes());
                }
            }
            Err(_) => continue, // skip corrupt packet
        }
    }

    if pcm.is_empty() {
        return Err("decoded zero samples (unsupported AAC variant?)".into());
    }

    let mut wav = Vec::with_capacity(pcm.len() + 44);
    write_wav_header(&mut wav, channels, sample_rate, pcm.len() as u32);
    wav.extend_from_slice(&pcm);
    Ok(wav)
}

async fn get_or_transcode(id: &str, entry: &StreamEntry) -> Result<Arc<Vec<u8>>, String> {
    if let Some((_, wav)) = wav_cache().lock().unwrap().iter().find(|(k, _)| k == id) {
        return Ok(wav.clone());
    }
    // googlevideo rejects bare full-file GETs (403) but accepts open-ended
    // Range requests (206) — matches on-device diagnostics.
    let resp = client()
        .get(&entry.url)
        .header("User-Agent", entry.ua.clone())
        .header("Range", "bytes=0-")
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    let st = resp.status().as_u16();
    if !(st == 200 || st == 206) {
        return Err(format!("download status {st}"));
    }
    let data = resp
        .bytes()
        .await
        .map_err(|e| format!("download body failed: {e}"))?
        .to_vec();
    if data.len() < 10_000 {
        return Err(format!("download too small: {} bytes", data.len()));
    }

    let wav = tauri::async_runtime::spawn_blocking(move || decode_aac_to_wav(data))
        .await
        .map_err(|e| format!("join failed: {e}"))??;

    let wav = Arc::new(wav);
    {
        let mut cache = wav_cache().lock().unwrap();
        cache.push((id.to_string(), wav.clone()));
        while cache.len() > 1 {
            cache.remove(0);
        }
    }
    Ok(wav)
}

fn err_response(status: u16, msg: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

fn parse_range(range: &str, len: u64) -> Option<(u64, u64)> {
    let r = range.trim().strip_prefix("bytes=")?;
    let mut parts = r.splitn(2, '-');
    let start_s = parts.next()?.trim();
    let end_s = parts.next().unwrap_or("").trim();
    if start_s.is_empty() {
        // suffix range: bytes=-N
        let n: u64 = end_s.parse().ok()?;
        let start = len.saturating_sub(n);
        return Some((start, len - 1));
    }
    let start: u64 = start_s.parse().ok()?;
    let end: u64 = if end_s.is_empty() {
        len - 1
    } else {
        end_s.parse().ok()?
    };
    if start >= len || end < start {
        return None;
    }
    Some((start, end.min(len - 1)))
}

fn serve_bytes(
    data: &[u8],
    range: Option<String>,
    content_type: &str,
) -> tauri::http::Response<Vec<u8>> {
    let len = data.len() as u64;
    match range.as_deref().and_then(|r| parse_range(r, len)) {
        Some((start, end)) => {
            let body = data[start as usize..=(end as usize)].to_vec();
            tauri::http::Response::builder()
                .status(206)
                .header("Content-Type", content_type)
                .header("Accept-Ranges", "bytes")
                .header("Content-Length", body.len().to_string())
                .header("Content-Range", format!("bytes {start}-{end}/{len}"))
                .header("Access-Control-Allow-Origin", "*")
                .body(body)
                .unwrap_or_else(|_| err_response(500, "build failed"))
        }
        None => tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", content_type)
            .header("Accept-Ranges", "bytes")
            .header("Content-Length", data.len().to_string())
            .header("Access-Control-Allow-Origin", "*")
            .body(data.to_vec())
            .unwrap_or_else(|_| err_response(500, "build failed")),
    }
}

async fn proxy_stream(id: String, range: Option<String>) -> tauri::http::Response<Vec<u8>> {
    let entry = { streams().lock().unwrap().get(&id).cloned() };
    let Some(entry) = entry else {
        return err_response(404, "unknown stream id");
    };

    if entry.transcode {
        return match get_or_transcode(&id, &entry).await {
            Ok(wav) => serve_bytes(&wav, range, "audio/wav"),
            Err(e) => err_response(502, &format!("transcode: {e}")),
        };
    }

    // Pass-through proxy with the registered client UA.
    let mut req = client().get(&entry.url).header("User-Agent", entry.ua.clone());
    if let Some(r) = &range {
        req = req.header("Range", r.clone());
    }
    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let mut builder = tauri::http::Response::builder()
                .status(status)
                .header("Accept-Ranges", "bytes")
                .header("Access-Control-Allow-Origin", "*");
            for key in ["content-type", "content-length", "content-range"] {
                if let Some(v) = resp.headers().get(key) {
                    if let Ok(s) = v.to_str() {
                        builder = builder.header(key, s);
                    }
                }
            }
            let body = match resp.bytes().await {
                Ok(b) => b.to_vec(),
                Err(_) => return err_response(502, "body read failed"),
            };
            builder
                .body(body)
                .unwrap_or_else(|_| err_response(500, "build failed"))
        }
        Err(e) => err_response(502, &format!("fetch: {e}")),
    }
}

/// Open a URL in the system default browser.
#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) urls allowed".into());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![http_request, register_stream, open_url])
        .register_asynchronous_uri_scheme_protocol("stream", |_ctx, request, responder| {
            let id = request
                .uri()
                .path()
                .trim_start_matches('/')
                .split(['?', '#'])
                .next()
                .unwrap_or("")
                .to_string();
            let range = request
                .headers()
                .get("range")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            tauri::async_runtime::spawn(async move {
                let resp = proxy_stream(id, range).await;
                responder.respond(resp);
            });
        })
        .run(tauri::generate_context!())
        .expect("error while running KanadeTune");
}
