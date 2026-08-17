// auth.js — Google sign-in for personalized content.
// Primary: OAuth *device code* flow (the same one TVs use) supported by
// youtubei.js — no client secret ships with the app. The user is shown a
// short code + google.com/device link; tokens are cached locally.
// Fallback: paste-your-cookie (power users), stored only on-device.
import { Innertube, UniversalCache } from 'youtubei.js/web';
import { tauriFetch as tfetch } from './tfetch.js';

const CREDS_KEY = 'kanade.oauth';

export function hasOAuth() { return !!localStorage.getItem(CREDS_KEY); }

export function loadCreds() {
  try { return JSON.parse(localStorage.getItem(CREDS_KEY) || 'null'); } catch { return null; }
}
export function saveCreds(c) {
  if (c) localStorage.setItem(CREDS_KEY, JSON.stringify(c));
  else localStorage.removeItem(CREDS_KEY);
}

// Starts the device-code sign-in. onCode({ verification_url, user_code }) is
// called when Google issues the code; resolves once sign-in completes.
export async function signIn(onCode) {
  const yt = await Innertube.create({
    fetch: (i, init) => tfetch(i, init),
    cache: new UniversalCache(false),

  });

  return new Promise((resolve, reject) => {
    let settled = false;
    yt.session.on('auth-pending', (data) => {
      try { onCode?.({ url: data.verification_url, code: data.user_code }); } catch { /* ui */ }
    });
    yt.session.on('auth', ({ credentials }) => {
      if (settled) return; settled = true;
      saveCreds(credentials);
      resolve(credentials);
    });
    yt.session.on('auth-error', (err) => {
      if (settled) return; settled = true;
      reject(err instanceof Error ? err : new Error(String(err?.message || err || 'auth failed')));
    });
    yt.session.signIn().catch((e) => {
      if (!settled) { settled = true; reject(e); }
    });
  });
}

export async function signOut() {
  const creds = loadCreds();
  saveCreds(null);
  if (!creds) return;
  try {
    const yt = await Innertube.create({
      fetch: (i, init) => tfetch(i, init),
      cache: new UniversalCache(false),

    });
    await yt.session.signIn(creds);
    await yt.session.signOut(); // revoke token server-side
  } catch { /* token may already be dead — local state is cleared regardless */ }
}
