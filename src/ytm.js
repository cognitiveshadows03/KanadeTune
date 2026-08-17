// ytm.js — InnerTube service layer, runs inside the WebView.
// All HTTP goes through Tauri's Rust core (plugin-http fetch) => no CORS, no backend.
// Session is created with the user's region (detected from their IP) + language,
// and optionally with the user's Google/YouTube cookies for personalized content.
import { Innertube, UniversalCache } from 'youtubei.js/web';
import { tauriFetch as tfetch } from './tfetch.js';
import { loadCreds, saveCreds } from './auth.js';

let ytPromise = null;

async function detectRegion() {
  const override = localStorage.getItem('kanade.region');
  if (override && override !== 'auto') return override;
  const cached = localStorage.getItem('kanade.geo');
  if (cached) return cached;
  try {
    const res = await tfetch('https://ipwho.is/', { headers: { Accept: 'application/json' } });
    const j = await res.json();
    if (j?.country_code) {
      localStorage.setItem('kanade.geo', j.country_code);
      return j.country_code;
    }
  } catch { /* offline / blocked */ }
  return 'US';
}

function getYT() {
  if (!ytPromise) {
    ytPromise = (async () => {
      const location = await detectRegion();
      const lang = (navigator.language || 'en').split('-')[0];
      const cookie = localStorage.getItem('kanade.cookie') || undefined;
      const yt = await Innertube.create({
        fetch: (input, init) => tfetch(input, init),
        cache: new UniversalCache(false),
        generate_session_locally: true,
        location,
        lang,
        cookie
      });
      // Attach OAuth credentials if the user signed in with Google.
      const creds = loadCreds();
      if (creds) {
        try {
          yt.session.on('update-credentials', ({ credentials }) => saveCreds(credentials));
          await yt.session.signIn(creds);
        } catch { saveCreds(null); /* stale token -> anonymous session */ }
      }
      return yt;
    })();
  }
  return ytPromise;
}

// Re-create the session (after sign-in/out or region change).
export function reinit() { ytPromise = null; return getYT(); }
export function isSignedIn() { return !!loadCreds() || !!localStorage.getItem('kanade.cookie'); }
export function setCookie(c) {
  if (c) localStorage.setItem('kanade.cookie', String(c).trim());
  else localStorage.removeItem('kanade.cookie');
  return reinit();
}

const PLAYABLE = /^[A-Za-z0-9_-]{11}$/;

function textOf(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (typeof t.text === 'string') return t.text;
  try { return t.toString(); } catch { return ''; }
}

// Upgrade tiny API thumbnails to crisp sizes (googleusercontent/ggpht support size params).
function upThumb(url) {
  if (!url) return url;
  if (/googleusercontent\.com|ggpht\.com/.test(url)) {
    return url.replace(/=w\d+-h\d+[^ ]*$/, '=w544-h544-l90-rj').replace(/=s\d+[^ ]*$/, '=s544');
  }
  return url;
}

function thumbOf(item) {
  let t = item?.thumbnail ?? item?.thumbnails ?? null;
  if (t && Array.isArray(t.contents)) t = t.contents;
  if (t && !Array.isArray(t) && Array.isArray(t.thumbnails)) t = t.thumbnails;
  if (!t) return null;
  if (!Array.isArray(t)) return typeof t.url === 'string' ? upThumb(t.url) : null;
  if (!t.length) return null;
  let best = t[0];
  for (const x of t) if ((x?.width || 0) > (best?.width || 0)) best = x;
  return upThumb(best?.url ?? null);
}

function normItem(item) {
  if (!item) return null;
  const id = item.id ?? item.video_id ?? item.videoId ?? item?.endpoint?.payload?.videoId ?? null;
  const title = textOf(item.title) || textOf(item.name);
  if (!id || !title) return null;
  let artist = '';
  if (Array.isArray(item.artists) && item.artists.length) artist = item.artists.map(a => a?.name).filter(Boolean).join(', ');
  else if (Array.isArray(item.authors) && item.authors.length) artist = item.authors.map(a => a?.name).filter(Boolean).join(', ');
  else if (item.author?.name) artist = item.author.name;
  else if (typeof item.author === 'string') artist = item.author;
  else artist = textOf(item.subtitle);
  const duration = item.duration?.text ?? (typeof item.duration === 'string' ? item.duration : '') ?? '';
  const playable = PLAYABLE.test(id);
  return {
    id, title,
    artist: artist || '',
    duration: duration || '',
    thumb: thumbOf(item),
    type: item.item_type ?? (playable ? 'song' : 'other'),
    playable
  };
}

function collectSections(feedSections) {
  const sections = [];
  for (const s of feedSections ?? []) {
    const title = textOf(s?.header?.title) || textOf(s?.title) || 'For you';
    const items = [];
    for (const raw of s?.contents ?? []) {
      const it = normItem(raw);
      if (!it) continue;
      if (it.playable) { items.push(it); continue; }
      if (raw.item_type === 'playlist' || raw.item_type === 'album' || /^(VL|OLAK|RDCLAK|MPRE)/.test(it.id)) {
        items.push({ ...it, type: raw.item_type || 'playlist', playable: false });
      }
    }
    if (items.length) sections.push({ title, items });
  }
  return sections;
}

export async function home() {
  const yt = await getYT();
  const feed = await yt.music.getHomeFeed();
  let sections = collectSections(feed?.sections);
  // pull one continuation for a richer feed
  try {
    if (feed?.has_continuation) {
      const more = await feed.getContinuation();
      sections = sections.concat(collectSections(more?.sections));
    }
  } catch { /* fine */ }
  return sections;
}

export async function search(q) {
  const yt = await getYT();
  const out = [];
  const seen = new Set();
  let lastErr = null;
  for (const type of ['song', 'video']) {
    try {
      const res = await yt.music.search(q, { type });
      for (const section of res?.contents ?? []) {
        for (const raw of section?.contents ?? []) {
          const it = normItem(raw);
          if (it && it.playable && !seen.has(it.id)) { seen.add(it.id); out.push(it); }
        }
      }
    } catch (e) { lastErr = e; }
  }
  if (!out.length) {
    // fallback: general YouTube search restricted to videos
    try {
      const res = await yt.search(q, { type: 'video' });
      for (const raw of res?.videos ?? []) {
        const it = normItem(raw);
        if (it && it.playable && !seen.has(it.id)) { seen.add(it.id); out.push(it); }
      }
    } catch (e) { lastErr = e; }
  }
  if (!out.length && lastErr) throw lastErr;
  return out;
}

export async function expand(id) {
  const yt = await getYT();
  const out = [];
  const seen = new Set();
  const collect = (contents) => {
    for (const raw of contents ?? []) {
      const it = normItem(raw);
      if (it && it.playable && !seen.has(it.id)) { seen.add(it.id); out.push(it); }
    }
  };
  try {
    if (/^MPRE/.test(id)) {
      const album = await yt.music.getAlbum(id);
      collect(album?.contents);
    } else {
      const pl = await yt.music.getPlaylist(id.replace(/^VL/, ''));
      collect(pl?.contents ?? pl?.items);
      let cont = pl, hops = 0;
      while (cont?.has_continuation && hops < 3) {
        cont = await cont.getContinuation();
        collect(cont?.contents ?? cont?.items);
        hops++;
      }
    }
  } catch (e) { if (!out.length) throw e; }
  return out;
}

// Signed-in library: playlists, albums, liked songs entry.
export async function library() {
  const yt = await getYT();
  const out = [];
  try {
    const lib = await yt.music.getLibrary();
    for (const s of lib?.contents ?? []) {
      for (const raw of s?.contents ?? []) {
        const it = normItem(raw);
        if (it) out.push(it);
      }
    }
  } catch { /* not signed in or shape change */ }
  return out;
}

// Playback-client fallback chain — direct-URL clients first, deciphering last.
// Each entry carries the User-Agent googlevideo expects for URLs issued to
// that client; the audio proxy must fetch with the SAME UA or it gets 403.
const CLIENTS = [
  { name: 'IOS', ua: 'com.google.ios.youtube/20.11.6 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X; US)' },
  { name: 'ANDROID', ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14; en_US; SM-S928B) gzip' },
  { name: 'TV_EMBEDDED', ua: 'Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' },
  { name: 'WEB', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' }
];

export async function stream(id) {
  const yt = await getYT();
  let lastErr = null;
  for (const { name, ua } of CLIENTS) {
    try {
      const info = await yt.getBasicInfo(id, { client: name });
      const fmt = info.chooseFormat({ type: 'audio', quality: 'best' });
      if (!fmt) continue;
      let url = fmt.url;
      if (!url && typeof fmt.decipher === 'function') {
        try { url = fmt.decipher(yt.session.player); } catch { /* next client */ }
      }
      if (typeof url === 'string' && url.startsWith('http')) {
        return {
          url,
          ua,
          mime: fmt.mime_type || '',
          bitrate: fmt.bitrate || 0,
          durationSec: info.basic_info?.duration ?? null,
          client: name
        };
      }
    } catch (e) { lastErr = e; }
  }
  throw new Error('No playable stream found' + (lastErr ? `: ${lastErr.message}` : ''));
}

export async function upNext(id) {
  const yt = await getYT();
  try {
    const un = await yt.music.getUpNext(id);
    return (un?.contents ?? []).map(normItem).filter(x => x && x.playable);
  } catch { return []; }
}

export async function lyrics({ id, title, artist, durationSec }) {
  const clean = (s) => String(s || '').replace(/\(.*?\)|\[.*?\]/g, '').trim();
  try {
    const params = new URLSearchParams({ track_name: clean(title), artist_name: clean(artist) });
    const res = await tfetch('https://lrclib.net/api/search?' + params, {
      headers: { 'User-Agent': 'KanadeTune/0.3 (https://github.com/cognitiveshadows03/KanadeTune)' }
    });
    if (res.ok) {
      const arr = await res.json();
      let best = null, bestScore = -1;
      for (const c of arr ?? []) {
        if (!c) continue;
        let score = 0;
        if (c.syncedLyrics) score += 10;
        if (durationSec && c.duration) score += Math.max(0, 5 - Math.abs(c.duration - durationSec));
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (best && (best.syncedLyrics || best.plainLyrics)) {
        return { synced: best.syncedLyrics || null, plain: best.plainLyrics || null, source: 'LRCLIB' };
      }
    }
  } catch { /* fall through */ }
  try {
    const yt = await getYT();
    const info = await yt.music.getInfo(id);
    const lyr = await info.getLyrics?.();
    const text = textOf(lyr?.description) || textOf(lyr?.text);
    if (text) return { synced: null, plain: text, source: 'YouTube Music' };
  } catch { /* none */ }
  return { synced: null, plain: null, source: null };
}
