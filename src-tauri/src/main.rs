// KanadeTune — Tauri 2 shell.
// HTTP for the InnerTube layer is implemented HERE as a custom command using
// reqwest, because tauri-plugin-http mangled Request headers/bodies from
// youtubei.js (silent drops -> YouTube 403). With our own command we control
// every byte: method, headers, body, redirects.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::sync::OnceLock;

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
        // reqwest rejects some forbidden headers silently; set what we can.
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![http_request])
        .run(tauri::generate_context!())
        .expect("error while running KanadeTune");
}
