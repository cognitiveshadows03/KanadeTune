// KanadeTune — Tauri 2 shell.
// Two Rust-owned network paths (tauri-plugin-http proved unreliable):
//  1) http_request command — byte-exact HTTP for the InnerTube layer (reqwest).
//  2) `stream` URI scheme — proxies googlevideo audio with the User-Agent of
//     the InnerTube client that issued the URL. The WebView's <audio> element
//     otherwise fetches with an Edge fingerprint, which googlevideo rejects
//     (403) because it does not match the client that requested the URL.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

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

fn streams() -> &'static Mutex<HashMap<String, (String, String)>> {
    static S: OnceLock<Mutex<HashMap<String, (String, String)>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
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

/// Register a stream URL + the User-Agent it must be fetched with.
/// The webview then plays it via stream://localhost/<id> (macOS/Linux)
/// or http://stream.localhost/<id> (Windows).
#[tauri::command]
fn register_stream(id: String, url: String, ua: String) {
    streams().lock().unwrap().insert(id, (url, ua));
}

fn err_response(status: u16) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .body(Vec::new())
        .unwrap()
}

async fn proxy_stream(id: String, range: Option<String>) -> tauri::http::Response<Vec<u8>> {
    let entry = { streams().lock().unwrap().get(&id).cloned() };
    let Some((url, ua)) = entry else {
        return err_response(404);
    };

    let mut req = client().get(&url).header("User-Agent", ua);
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
                Err(_) => return err_response(502),
            };
            builder.body(body).unwrap_or_else(|_| err_response(500))
        }
        Err(_) => err_response(502),
    }
}

/// Open a URL in the system default browser. The JS-side opener plugin call
/// silently failed on some machines; this command uses the plugin's Rust API.
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
