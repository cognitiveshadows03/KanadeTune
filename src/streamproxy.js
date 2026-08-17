// streamproxy.js — plays googlevideo audio through the Rust `stream` URI
// scheme so the fetch carries the InnerTube client's User-Agent (the
// webview's own Edge UA gets 403 from googlevideo).
import { invoke } from '@tauri-apps/api/core';

const IS_WINDOWS = navigator.userAgent.includes('Windows');

// Windows maps custom schemes to http://<scheme>.localhost/, other platforms
// use <scheme>://localhost/.
export function streamUrl(id) {
  return IS_WINDOWS ? `http://stream.localhost/${id}` : `stream://localhost/${id}`;
}

export async function registerStream(id, url, ua) {
  await invoke('register_stream', { id, url, ua });
  return streamUrl(id);
}
