// tfetch.js — fetch adapter for tauri-plugin-http.
// youtubei.js calls fetch(new Request(url, { headers, body, ... })).
// The Tauri http plugin can silently drop headers/body when handed a Request
// object, which makes InnerTube return 403. This adapter normalizes every
// call to the (url, init) form with headers/body explicitly extracted, and
// fills in browser-equivalent headers that the Rust client doesn't add.
import { fetch as pluginFetch } from '@tauri-apps/plugin-http';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export async function tauriFetch(input, init) {
  let url, opts;

  if (typeof Request !== 'undefined' && input instanceof Request) {
    url = input.url;
    const headers = new Headers(input.headers);
    if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    let body = init?.body;
    if (body === undefined && input.method !== 'GET' && input.method !== 'HEAD') {
      const buf = await input.clone().arrayBuffer();
      if (buf && buf.byteLength) body = buf;
    }
    opts = {
      method: init?.method ?? input.method ?? 'GET',
      headers,
      body,
      redirect: init?.redirect ?? input.redirect
    };
  } else {
    url = typeof input === 'string' ? input : String(input?.url ?? input);
    opts = { ...(init || {}) };
    opts.headers = new Headers(init?.headers || {});
  }

  // Browser-parity headers YouTube expects; the Rust HTTP client won't set these.
  const h = opts.headers;
  if (!h.has('user-agent')) h.set('User-Agent', UA);
  try {
    const u = new URL(url);
    if (/(^|\.)youtube\.com$|(^|\.)googleapis\.com$/.test(u.hostname)) {
      if (!h.has('origin')) h.set('Origin', 'https://www.youtube.com');
      if (!h.has('referer')) h.set('Referer', 'https://www.youtube.com/');
    }
  } catch { /* non-URL input */ }

  return pluginFetch(url, opts);
}
