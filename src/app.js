// KanadeTune renderer entry (bundled by esbuild -> www/bundle.js).
// Continuous UI (seek, lyrics) is rAF-driven => native display refresh rate.
// All artwork flows through the size-capped LRU cache (artcache.js).
import * as ytm from './ytm.js';
import { getArt, hydrateArt, usageBytes, setCapMB, capBytes, clearAll } from './artcache.js';
import { fetch as tfetch } from '@tauri-apps/plugin-http';
import { openUrl } from './shell.js';

const $ = (s) => document.querySelector(s);

const ICON_PLAY = 'M8 5v14l11-7z';
const ICON_PAUSE = 'M7 5h4v14H7zM13 5h4v14h-4z';

const state = {
  queue: [], index: -1,
  playing: false, seeking: false, seekPos: 0,
  lyrics: null, lyricsOn: false, queueOn: false,
  recents: JSON.parse(localStorage.getItem('kanade.recents') || '[]'),
  streamMeta: null
};

const audio = new Audio();
audio.preload = 'auto';
audio.volume = Number(localStorage.getItem('kanade.vol') || 0.8);

/* ---------- helpers ---------- */
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cur = () => state.queue[state.index] || null;

async function setImg(el, url) { el.src = await getArt(url); }

/* ---------- accent color from artwork ---------- */
const cvs = document.createElement('canvas');
async function applyAccent(artUrl) {
  if (!artUrl) return;
  try {
    const src = await getArt(artUrl);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
    const x = cvs.getContext('2d', { willReadFrequently: true });
    cvs.width = cvs.height = 20;
    x.drawImage(img, 0, 0, 20, 20);
    const d = x.getImageData(0, 0, 20, 20).data;
    let best = [159, 184, 255], bestScore = -1;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx ? (mx - mn) / mx : 0, lum = mx / 255;
      const score = sat * (1 - Math.abs(lum - 0.6));
      if (score > bestScore) { bestScore = score; best = [r, g, b]; }
    }
    const [r, g, b] = best.map(v => Math.round(v + (255 - v) * 0.42));
    document.documentElement.style.setProperty('--accent', `rgb(${r},${g},${b})`);
    document.documentElement.style.setProperty('--accent-ink',
      (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#10131c' : '#ffffff');
  } catch { /* keep current accent */ }
}

/* ---------- navigation ---------- */
document.querySelectorAll('.railBtn').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.railBtn').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + b.dataset.view));
    if (b.dataset.view === 'search') setTimeout(() => $('#searchInput').focus(), 50);
    if (b.dataset.view === 'library') renderRecents();
    if (b.dataset.view === 'settings') refreshCacheUsage();
  });
});

/* ---------- home ---------- */
async function loadHome() {
  const el = $('#homeFeed');
  try {
    const sections = await ytm.home();
    if (!sections.length) { el.innerHTML = '<div class="muted pad">Nothing here — try Search!</div>'; return; }
    el.innerHTML = sections.map((s, si) => `
      <h2 class="secTitle">${esc(s.title)}</h2>
      <div class="shelfRow">${s.items.map((it, ii) => `
        <div class="card" data-s="${si}" data-i="${ii}">
          <img loading="lazy" data-art="${esc(it.thumb || '')}" alt="" />
          <div class="cT">${esc(it.title)}</div>
          <div class="cA">${esc(it.artist)}</div>
        </div>`).join('')}
      </div>`).join('');
    hydrateArt(el);
    el._sections = sections;
    el.onclick = async (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      const s = el._sections[+card.dataset.s];
      const item = s.items[+card.dataset.i];
      if (item.playable) {
        const p = s.items.filter(x => x.playable);
        playList(p, p.indexOf(item));
        return;
      }
      card.classList.add('busy');
      try {
        const tracks = await ytm.expand(item.id);
        if (tracks.length) playList(tracks, 0);
      } catch { /* ignore */ }
      card.classList.remove('busy');
    };
  } catch (e) {
    el.innerHTML = `<div class="muted pad">Couldn't load the feed (${esc(e.message)}). Search still works!</div>`;
  }
}

/* ---------- search ---------- */
let searchTimer = null;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { $('#searchResults').innerHTML = ''; return; }
  searchTimer = setTimeout(() => runSearch(q), 320);
});
$('#searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(e.target.value.trim()); }
});

async function runSearch(q) {
  if (!q) return;
  const el = $('#searchResults');
  el.innerHTML = '<div class="muted pad">Searching…</div>';
  try {
    const items = await ytm.search(q);
    if (!items.length) { el.innerHTML = '<div class="muted pad">No results.</div>'; return; }
    el.innerHTML = `<div class="songList">${items.map((it, i) => rowHTML(it, i)).join('')}</div>`;
    hydrateArt(el);
    el._items = items;
    el.onclick = (e) => {
      const row = e.target.closest('.songRow');
      if (row) playList(el._items, +row.dataset.i);
    };
  } catch (err) {
    el.innerHTML = `<div class="muted pad">Search failed: ${esc(err.message)}</div>`;
  }
}

function rowHTML(it, i) {
  return `<div class="songRow" data-i="${i}" data-id="${esc(it.id)}">
    <img loading="lazy" data-art="${esc(it.thumb || '')}" alt="" />
    <div><div class="sT">${esc(it.title)}</div><div class="sA">${esc(it.artist)}</div></div>
    <div class="sD">${esc(it.duration)}</div>
  </div>`;
}

/* ---------- library ---------- */
function renderRecents() {
  const el = $('#recentList');
  $('#libraryEmpty').style.display = state.recents.length ? 'none' : 'block';
  el.innerHTML = state.recents.map((it, i) => rowHTML(it, i)).join('');
  hydrateArt(el);
  el.onclick = (e) => {
    const row = e.target.closest('.songRow');
    if (row) playList(state.recents.slice(), +row.dataset.i);
  };
}
function pushRecent(it) {
  state.recents = [it, ...state.recents.filter(x => x.id !== it.id)].slice(0, 60);
  localStorage.setItem('kanade.recents', JSON.stringify(state.recents));
}

/* ---------- playback ---------- */
async function playList(items, index) {
  state.queue = items.slice();
  state.index = index;
  await playCurrent();
  if (state.queue.length - state.index < 3) {
    const t = cur();
    if (t) ytm.upNext(t.id).then((next) => {
      const have = new Set(state.queue.map(x => x.id));
      for (const n of next) if (!have.has(n.id)) state.queue.push(n);
      renderQueue();
    }).catch(() => {});
  }
}

let playToken = 0;
async function playCurrent() {
  const t = cur();
  if (!t) return;
  const my = ++playToken;
  setNowPlayingUI(t);
  setPlayIcon('load');
  try {
    const meta = await ytm.stream(t.id);
    if (my !== playToken) return;
    state.streamMeta = meta;
    const codec = /opus/i.test(meta.mime) ? 'OPUS' : /mp4a|aac/i.test(meta.mime) ? 'AAC' : (meta.mime.split(';')[0].split('/')[1] || '—').toUpperCase();
    $('#fmtBadge').textContent = `${codec} · ${Math.round((meta.bitrate || 0) / 1000)} kbps · ${meta.client}`;
    audio.src = meta.url;
    await audio.play();
    if (my !== playToken) return;
    pushRecent(t);
    loadLyrics(t, meta);
    setMediaSession(t);
  } catch {
    if (my !== playToken) return;
    setPlayIcon();
    next(); // skip unplayable
  }
}

function setNowPlayingUI(t) {
  $('#miniPlayer').classList.remove('hidden');
  $('#miniTitle').textContent = t.title;
  $('#miniArtist').textContent = t.artist;
  $('#playerTitle').textContent = t.title;
  $('#playerArtist').textContent = t.artist;
  $('#fmtBadge').textContent = '…';
  setImg($('#miniArt'), t.thumb);
  setImg($('#playerArt'), t.thumb);
  getArt(t.thumb).then(u => { $('#playerBg').style.backgroundImage = `url("${u}")`; });
  applyAccent(t.thumb);
  document.title = `${t.title} — ${t.artist} · KanadeTune`;
  document.querySelectorAll('.songRow').forEach(r => r.classList.toggle('playing', r.dataset.id === t.id));
  renderQueue();
}

function setPlayIcon(mode) {
  const d = mode === 'load' ? ICON_PAUSE : (state.playing ? ICON_PAUSE : ICON_PLAY);
  document.querySelectorAll('.iconPlay').forEach(p => p.setAttribute('d', d));
}

function togglePlay() {
  if (!audio.src) return;
  if (audio.paused) audio.play(); else audio.pause();
}
function next() { if (state.index < state.queue.length - 1) { state.index++; playCurrent(); } }
function prev() {
  if (audio.currentTime > 4) { audio.currentTime = 0; return; }
  if (state.index > 0) { state.index--; playCurrent(); }
}

audio.addEventListener('ended', next);
audio.addEventListener('play', () => { state.playing = true; setPlayIcon(); });
audio.addEventListener('pause', () => { state.playing = false; setPlayIcon(); });
audio.addEventListener('error', () => { if (audio.src) next(); });

function setMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist,
    artwork: t.thumb ? [{ src: t.thumb, sizes: '512x512' }] : []
  });
  navigator.mediaSession.setActionHandler('play', togglePlay);
  navigator.mediaSession.setActionHandler('pause', togglePlay);
  navigator.mediaSession.setActionHandler('nexttrack', next);
  navigator.mediaSession.setActionHandler('previoustrack', prev);
}

/* ---------- rAF loop: progress + lyrics at native refresh rate ---------- */
const seekFill = $('#seekFill'), seekThumb = $('#seekThumb'), miniFill = $('#miniProgFill');
let lastSec = -1, lastLyricIdx = -1;

function frame() {
  const dur = audio.duration || 0;
  const pos = state.seeking ? state.seekPos : (audio.currentTime || 0);
  const p = dur ? Math.min(pos / dur, 1) : 0;
  seekFill.style.transform = `scaleX(${p})`;
  miniFill.style.transform = `scaleX(${p})`;
  seekThumb.style.transform = `translate(${p * $('#seekBar').clientWidth - 6}px, -50%)`;
  const sec = Math.floor(pos);
  if (sec !== lastSec) {
    lastSec = sec;
    $('#tCur').textContent = fmtTime(pos);
    $('#tTot').textContent = fmtTime(dur);
  }
  if (state.lyricsOn && state.lyrics?.lines) syncLyrics(pos);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ---------- seek ---------- */
const seekWrap = $('#seekWrap');
function seekFrom(e) {
  const r = $('#seekBar').getBoundingClientRect();
  state.seekPos = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * (audio.duration || 0);
}
seekWrap.addEventListener('pointerdown', (e) => {
  if (!audio.duration) return;
  state.seeking = true; seekFrom(e);
  seekWrap.setPointerCapture(e.pointerId);
});
seekWrap.addEventListener('pointermove', (e) => { if (state.seeking) seekFrom(e); });
seekWrap.addEventListener('pointerup', () => {
  if (!state.seeking) return;
  audio.currentTime = state.seekPos || 0;
  state.seeking = false;
});

/* ---------- volume ---------- */
$('#vol').value = Math.round(audio.volume * 100);
$('#vol').addEventListener('input', (e) => {
  audio.volume = e.target.value / 100;
  if ($('#rememberVol').checked) localStorage.setItem('kanade.vol', audio.volume);
});

/* ---------- player open/close + controls ---------- */
$('#miniPlayer').addEventListener('click', (e) => {
  if (e.target.closest('.cbtn')) return;
  $('#player').classList.remove('closed');
});
$('#playerClose').addEventListener('click', () => $('#player').classList.add('closed'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#player').classList.add('closed');
  if (e.key === ' ' && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) { e.preventDefault(); togglePlay(); }
});
$('#miniPlay').addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
$('#miniNext').addEventListener('click', (e) => { e.stopPropagation(); next(); });
$('#miniPrev').addEventListener('click', (e) => { e.stopPropagation(); prev(); });
$('#btnPlay').addEventListener('click', togglePlay);
$('#btnNext').addEventListener('click', next);
$('#btnPrev').addEventListener('click', prev);

/* ---------- panes ---------- */
$('#btnLyrics').addEventListener('click', () => { state.lyricsOn = !state.lyricsOn; if (state.lyricsOn) state.queueOn = false; refreshPanes(); });
$('#btnQueue').addEventListener('click', () => { state.queueOn = !state.queueOn; if (state.queueOn) state.lyricsOn = false; refreshPanes(); });
function refreshPanes() {
  const any = state.lyricsOn || state.queueOn;
  $('#sidePane').classList.toggle('hidden', !any);
  $('#playerInner').classList.toggle('withPane', any);
  $('#lyricsPane').classList.toggle('hidden', !state.lyricsOn);
  $('#queuePane').classList.toggle('hidden', !state.queueOn);
  $('#btnLyrics').classList.toggle('on', state.lyricsOn);
  $('#btnQueue').classList.toggle('on', state.queueOn);
  if (!state.queueOn) $('#queueList').innerHTML = ''; // release DOM when closed
  else renderQueue();
}

function renderQueue() {
  if (!state.queueOn) return;
  const el = $('#queueList');
  el.innerHTML = state.queue.map((it, i) => rowHTML(it, i)).join('');
  hydrateArt(el);
  el.querySelectorAll('.songRow').forEach(r => r.classList.toggle('playing', +r.dataset.i === state.index));
  el.onclick = (e) => {
    const row = e.target.closest('.songRow');
    if (row) { state.index = +row.dataset.i; playCurrent(); }
  };
}

/* ---------- lyrics ---------- */
function parseLRC(lrc) {
  const lines = [];
  for (const raw of String(lrc).split('\n')) {
    const times = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!times.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of times) lines.push({ t: (+m[1]) * 60 + (+m[2]), text });
  }
  lines.sort((a, b) => a.t - b.t);
  return lines.filter(l => l.text);
}

let lyricsToken = 0;
async function loadLyrics(t, meta) {
  const my = ++lyricsToken;
  state.lyrics = null; lastLyricIdx = -1;
  $('#lyricsScroll').innerHTML = '<div class="lyNone">Looking for lyrics…</div>';
  try {
    const res = await ytm.lyrics({ id: t.id, title: t.title, artist: t.artist, durationSec: meta.durationSec });
    if (my !== lyricsToken) return;
    if (res.synced) {
      const lines = parseLRC(res.synced);
      state.lyrics = { lines };
      $('#lyricsScroll').innerHTML =
        lines.map((l, i) => `<div class="lyLine" data-i="${i}" data-t="${l.t}">${esc(l.text)}</div>`).join('') +
        `<div class="lyNone" style="padding-top:16px">Lyrics: ${esc(res.source)}</div>`;
      $('#lyricsScroll').onclick = (e) => {
        const ln = e.target.closest('.lyLine');
        if (ln) audio.currentTime = +ln.dataset.t;
      };
    } else if (res.plain) {
      state.lyrics = { plain: res.plain };
      $('#lyricsScroll').innerHTML = `<div class="lyPlain">${esc(res.plain)}</div><div class="lyNone" style="padding-top:16px">Lyrics: ${esc(res.source)}</div>`;
    } else {
      $('#lyricsScroll').innerHTML = '<div class="lyNone">No lyrics found for this track.</div>';
    }
  } catch {
    if (my === lyricsToken) $('#lyricsScroll').innerHTML = '<div class="lyNone">No lyrics found.</div>';
  }
}

function syncLyrics(pos) {
  const lines = state.lyrics.lines;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].t <= pos + 0.25) idx = i; else break; }
  if (idx === lastLyricIdx) return;
  lastLyricIdx = idx;
  const nodes = $('#lyricsScroll').querySelectorAll('.lyLine');
  nodes.forEach((n, i) => {
    n.classList.toggle('now', i === idx);
    n.classList.toggle('past', i < idx);
  });
  if (idx >= 0 && nodes[idx]) nodes[idx].scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ---------- settings ---------- */
const capSel = $('#cacheCap');
capSel.value = String(Math.round(capBytes() / 1024 / 1024));
if (!capSel.value || capSel.value === '0') capSel.value = '100';
capSel.addEventListener('change', () => { setCapMB(+capSel.value); refreshCacheUsage(); });
$('#clearCache').addEventListener('click', async () => { await clearAll(); refreshCacheUsage(); });
async function refreshCacheUsage() {
  const b = await usageBytes();
  $('#cacheUsage').textContent = `${(b / 1024 / 1024).toFixed(1)} MB of ${capSel.value} MB used`;
}

/* ---------- about ---------- */
document.querySelectorAll('.aboutCard.link').forEach(c =>
  c.addEventListener('click', () => openUrl(c.dataset.href)));
$('#runtimeInfo').textContent = navigator.userAgent.includes('Edg/') ? 'Runtime: WebView2 (Edge)' : '';

/* ---------- global media keys ---------- */
(async () => {
  try {
    const gs = await import('@tauri-apps/plugin-global-shortcut');
    await gs.register('MediaPlayPause', () => togglePlay());
    await gs.register('MediaTrackNext', () => next());
    await gs.register('MediaTrackPrevious', () => prev());
  } catch { /* optional */ }
})();

/* ---------- boot ---------- */
loadHome();
