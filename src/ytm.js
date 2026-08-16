// ytm.js — InnerTube service layer, runs inside the WebView.
// All HTTP goes through Tauri's Rust core (plugin-http fetch) => no CORS, no backend.
import { Innertube, UniversalCache } from 'youtubei.js/web';
import { fetch as tfetch } from '@tauri-apps/plugin-http';

let ytPromise = null;
function getYT() {
  if (!ytPromise) {
    ytPromise = Innertube.create({
      fetch: (input, init) => tfetch(input, init),
      cache: new UniversalCache(false),
      generate_session_locally: true
    });
  }
  return ytPromise;
}

const PLAYABLE = /^[A-Za-z0-9_-]{11}$/;

function textOf(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (typeof t.text === 'string') return t.text;
  try { return t.toString(); } catch { return ''; }
}

function thumbOf(item) {
  let t = item?.thumbnail ?? item?.thumbnails ?? null;
  if (t && Array.isArray(t.contents)) t = t.contents;
  if (t && !Array.isArray(t) && Array.isArray(t.thumbnails)) t = t.thumbnails;
  if (!t) return null;
  if (!Array.isArray(t)) return typeof t.url === 'string' ? t.url : null;
  if (!t.length) return null;
  let best = t[0];
  for (const x of t) if ((x?.width || 0) > (best?.width || 0)) best = x;
  return best?.url ?? null;
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
  return {
    id, title,
    artist: artist || '',
    duration: duration || '',
    thumb: thumbOf(item),
    type: item.item_type ?? (PLAYABLE.test(id) ? 'song' : 'other'),
    playable: PLAYABLE.test(id)
  };
}

export async function home() {
  const yt = await getYT();
  const feed = await yt.music.getHomeFeed();
  const sections = [];
  for (const s of feed?.sections ?? []) {
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

export async function search(q) {
  const yt = await getYT();
  const out = [];
  const seen = new Set();
  for (const type of ['song', 'video']) {
    try {
      const res = await yt.music.search(q, { type });
      for (const section of res?.contents ?? []) {
        for (const raw of section?.contents ?? []) {
          const it = normItem(raw);
          if (it && it.playable && !seen.has(it.id)) { seen.add(it.id); out.push(it); }
        }
      }
    } catch { /* one type failing is fine */ }
  }
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

// Playback-client fallback chain — clients returning direct URLs first,
// local player-JS deciphering as last resort.
const CLIENTS = ['IOS', 'ANDROID', 'TV_EMBEDDED', 'WEB'];

export async function stream(id) {
  const yt = await getYT();
  let lastErr = null;
  for (const client of CLIENTS) {
    try {
      const info = await yt.getBasicInfo(id, { client });
      const fmt = info.chooseFormat({ type: 'audio', quality: 'best' });
      if (!fmt) continue;
      let url = fmt.url;
      if (!url && typeof fmt.decipher === 'function') {
        try { url = fmt.decipher(yt.session.player); } catch { /* next client */ }
      }
      if (typeof url === 'string' && url.startsWith('http')) {
        return {
          url,
          mime: fmt.mime_type || '',
          bitrate: fmt.bitrate || 0,
          durationSec: info.basic_info?.duration ?? null,
          client
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
      headers: { 'User-Agent': 'KanadeTune/0.2 (https://github.com/cognitiveshadows03)' }
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
