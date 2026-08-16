// KanadeTune — Tauri 2 shell.
// The Rust core stays intentionally thin: window + plugins (http, shortcuts, opener).
// All app logic lives in the WebView; HTTP is routed through the http plugin,
// so requests to YouTube originate from the user's machine without CORS limits.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running KanadeTune");
}
