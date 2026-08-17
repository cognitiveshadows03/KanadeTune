// tfetch.js — fetch implementation backed by our own Rust `http_request`
// command (reqwest). We previously used tauri-plugin-http, but it mangled
// headers/bodies when youtubei.js passed Request objects -> YouTube 403.
// The Rust command receives explicit {url, method, headers[], bodyB64} so
// nothing can be silently dropped, and returns {status, headers, bodyB64}.
import { invoke } from '@tauri-apps/api/core';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function b64encode(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64decode(s) {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function extract(input, init) {
  let url, method = 'GET', headers = new Headers(), body;

  if (typeof Request !== 'undefined' && input instanceof Request) {
    url = input.url;
    method = input.method || 'GET';
    headers = new Headers(input.headers);
    if (input.method !== 'GET' && input.method !== 'HEAD') {
      const buf = await input.clone().arrayBuffer();
      if (buf && buf.byteLength) body = buf;
    }
  } else {
    url = typeof input === 'string' ? input : String(input?.url ?? input);
  }

  if (init) {
    if (init.method) method = init.method;
    if (init.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body === 'string') body = new TextEncoder().encode(init.body).buffer;
      else if (init.body instanceof ArrayBuffer) body = init.body;
      else if (ArrayBuffer.isView(init.body)) body = init.body.buffer.slice(init.body.byteOffset, init.body.byteOffset + init.body.byteLength);
      else if (init.body instanceof Blob) body = await init.body.arrayBuffer();
      else body = new TextEncoder().encode(String(init.body)).buffer;
    }
  }

  // Browser-parity headers YouTube expects.
  if (!headers.has('user-agent')) headers.set('User-Agent', UA);
  try {
    const u = new URL(url);
    if (/(^|\.)youtube\.com$|(^|\.)googleapis\.com$/.test(u.hostname)) {
      if (!headers.has('origin')) headers.set('Origin', 'https://www.youtube.com');
      if (!headers.has('referer')) headers.set('Referer', 'https://www.youtube.com/');
      if (!headers.has('accept-language')) headers.set('Accept-Language', 'en-US,en;q=0.9');
    }
  } catch { /* non-URL */ }

  return { url, method, headers, body };
}

export async function tauriFetch(input, init) {
  const { url, method, headers, body } = await extract(input, init);

  const headerList = [];
  headers.forEach((v, k) => headerList.push([k, v]));

  const resp = await invoke('http_request', {
    req: {
      url,
      method,
      headers: headerList,
      bodyB64: body ? b64encode(body) : null
    }
  });

  const respHeaders = new Headers();
  for (const [k, v] of resp.headers) {
    try { respHeaders.append(k, v); } catch { /* forbidden name */ }
  }

  return new Response(b64decode(resp.bodyB64), {
    status: resp.status,
    statusText: '',
    headers: respHeaders
  });
}

// Diagnostic probe used by the Settings > Diagnostics panel.
export async function probe() {
  const out = {};
  try {
    const r = await tauriFetch('https://www.youtube.com/generate_204');
    out.youtube_reachable = r.status;
  } catch (e) { out.youtube_reachable = 'ERR: ' + e.message; }
  try {
    const r = await tauriFetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240101.00.00', hl: 'en', gl: 'US' } },
        query: 'test'
      })
    });
    out.innertube_post = r.status;
    if (r.status !== 200) out.innertube_body = (await r.text()).slice(0, 300);
  } catch (e) { out.innertube_post = 'ERR: ' + e.message; }
  return out;
}
