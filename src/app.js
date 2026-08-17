// KanadeTune renderer entry (bundled by esbuild -> www/bundle.js).
// rAF-driven UI at native refresh rate; all artwork via size-capped LRU cache.
import * as ytm from './ytm.js';
import * as auth from './auth.js';
import { getArt, hydrateArt, usageBytes, setCapMB, capBytes, clearAll } from './artcache.js';
import { registerStream } from './streamproxy.js';
import { openUrl } from './shell.js';

const $ = (s) => document.querySelector(s);

const ICON_PLAY = 'M8 5v14l11-7z';
const ICON_PAUSE = 'M7 5h4v14H7zM13 5h4v14h-4z';

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
};

const state = {
  queue: [], index: -1,
  playing: false, seeking: false, seekPos: 0,
  lyrics: null, lyricsOn: false, queueOn: false,
  shuffle: false, repeat: 0, // 0 off, 1 all, 2 one
  speed: 1, sleepAt: null,
  recents: store.get('kanade.recents', []),
  history: store.get('kanade.history', []),
  favs: store.get('kanade.favs', []),
  streamMeta: null
};

let errorStreak = 0;
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
const isFav = (id) => state.favs.some(x => x.id === id);

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

async function setImg(el, url) { el.src = await getArt(url); }

/* ---------- accent color ---------- */
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
  } catch { /* keep accent */ }
}

/* ---------- navigation ---------- */
document.querySelectorAll('.railBtn').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.railBtn').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + b.dataset.view));
    if (b.dataset.view === 'search') setTimeout(() => $('#searchInput').focus(), 50);
    if (b.dataset.view === 'library') renderLibrary();
    if (b.dataset.view === 'history') renderHistory();
    if (b.dataset.view === 'settings') { refreshCacheUsage(); refreshAccountUI(); refreshRegionUI(); }
  });
});

/* ---------- rows / cards ---------- */
function rowHTML(it, i) {
  return `<div class="songRow" data-i="${i}" data-id="${esc(it.id)}">
    <img loading="lazy" data-art="${esc(it.thumb || '')}" alt="" />
    <div><div class="sT">${esc(it.title)}</div><div class="sA">${esc(it.artist)}${it.when ? ' · ' + esc(it.when) : ''}</div></div>
    <div style="display:flex;align-items:center;gap:6px">
      <button class="cbtn rowFav ${isFav(it.id) ? 'on' : ''}" data-fav="${esc(it.id)}" title="Favourite"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 21l-1.5-1.3C5.2 15 2 12.1 2 8.5 2 5.5 4.4 3 7.4 3c1.7 0 3.4.8 4.6 2.1C13.2 3.8 14.9 3 16.6 3 19.6 3 22 5.5 22 8.5c0 3.6-3.2 6.5-8.5 11.2z"/></svg></button>
      <div class="sD">${esc(it.duration || '')}</div>
    </div>
  </div>`;
}

function qpCardHTML(it, i) {
  return `<div class="qpCard" data-i="${i}" data-id="${esc(it.id)}">
    <img loading="lazy" data-art="${esc(it.thumb || '')}" alt="" />
    <div><div class="qT">${esc(it.title)}</div><div class="qA">${esc(it.artist)}</div></div>
    <div class="qD">${esc(it.duration || '')}</div>
  </div>`;
}

function bindList(el, items) {
  el.onclick = (e) => {
    const favBtn = e.target.closest('[data-fav]');
    if (favBtn) {
      const id = favBtn.dataset.fav;
      const it = items.find(x => x.id === id) || state.queue.find(x => x.id === id);
      toggleFav(it);
      favBtn.classList.toggle('on', isFav(id));
      return;
    }
    const row = e.target.closest('.songRow, .qpCard');
    if (row) playList(items, +row.dataset.i);
  };
}

/* ---------- home ---------- */
const QUICK_RE = /quick picks|for you|listen again/i;

async function loadHome() {
  const el = $('#homeFeed');
  el.innerHTML = '<div class="muted pad">Loading your feed…</div>';
  $('#signinHint').classList.toggle('hidden', ytm.isSignedIn());
  try {
    const sections = await ytm.home();
    if (!sections.length) { el.innerHTML = '<div class="muted pad">Nothing here — try Search!</div>'; return; }
    el.innerHTML = sections.map((s, si) => {
      const quick = QUICK_RE.test(s.title) && s.items.every(x => x.playable);
      if (quick) {
        return `<h2 class="secTitle">${esc(s.title)}</h2>
          <div class="qpGrid" data-s="${si}">${s.items.map((it, ii) => qpCardHTML(it, ii)).join('')}</div>`;
      }
      return `<h2 class="secTitle">${esc(s.title)}</h2>
        <div class="shelfRow" data-s="${si}">${s.items.map((it, ii) => `
          <div class="card" data-s="${si}" data-i="${ii}">
            <img loading="lazy" data-art="${esc(it.thumb || '')}" alt="" />
            <div class="cT">${esc(it.title)}</div>
            <div class="cA">${esc(it.artist)}</div>
          </div>`).join('')}
        </div>`;
    }).join('');
    hydrateArt(el);
    el._sections = sections;
    el.onclick = async (e) => {
      const node = e.target.closest('.card, .qpCard');
      if (!node) return;
      const wrap = node.closest('[data-s]');
      const s = el._sections[+(node.dataset.s ?? wrap.dataset.s)];
      const item = s.items[+node.dataset.i];
      if (item.playable) {
        const p = s.items.filter(x => x.playable);
        playList(p, p.indexOf(item));
        return;
      }
      node.classList.add('busy');
      try {
        const tracks = await ytm.expand(item.id);
        if (tracks.length) playList(tracks, 0);
        else toast('Playlist is empty or unavailable');
      } catch { toast('Could not open this playlist'); }
      node.classList.remove('busy');
    };
  } catch (e) {
    el.innerHTML = `<div class="muted pad">Couldn't load the feed (${esc(e.message)}). Search still works!</div>`;
  }
}
$('#homeRefresh').addEventListener('click', loadHome);
$('#hintSignin').addEventListener('click', () => {
  document.querySelector('[data-view="settings"]').click();
  startSignIn();
});

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

let searchToken = 0;
async function runSearch(q) {
  if (!q) return;
  const my = ++searchToken;
  const el = $('#searchResults');
  el.innerHTML = '<div class="muted pad">Searching…</div>';
  try {
    const items = await ytm.search(q);
    if (my !== searchToken) return;
    if (!items.length) { el.innerHTML = '<div class="muted pad">No results.</div>'; return; }
    el.innerHTML = `<div class="songList">${items.map((it, i) => rowHTML(it, i)).join('')}</div>`;
    hydrateArt(el);
    bindList(el, items);
  } catch (err) {
    if (my === searchToken) el.innerHTML = `<div class="muted pad">Search failed: ${esc(err.message)}</div>`;
  }
}

/* ---------- library / favourites ---------- */
async function renderLibrary() {
  const fl = $('#favList');
  $('#favEmpty').style.display = state.favs.length ? 'none' : 'block';
  fl.innerHTML = state.favs.map((it, i) => rowHTML(it, i)).join('');
  hydrateArt(fl);
  bindList(fl, state.favs);

  const rl = $('#recentList');
  $('#libraryEmpty').style.display = state.recents.length ? 'none' : 'block';
  rl.innerHTML = state.recents.map((it, i) => rowHTML(it, i)).join('');
  hydrateArt(rl);
  bindList(rl, state.recents);

  // Signed-in YT Music library
  const wrap = $('#ytLibraryWrap');
  if (ytm.isSignedIn()) {
    try {
      const items = await ytm.library();
      if (items.length) {
        wrap.classList.remove('hidden');
        const grid = $('#ytLibrary');
        grid.innerHTML = items.map((it, i) => qpCardHTML(it, i)).join('');
        hydrateArt(grid);
        grid.onclick = async (e) => {
          const node = e.target.closest('.qpCard');
          if (!node) return;
          const item = items[+node.dataset.i];
          if (item.playable) { playList(items.filter(x => x.playable), 0); return; }
          node.classList.add('busy');
          try {
            const tracks = await ytm.expand(item.id);
            if (tracks.length) playList(tracks, 0);
          } catch { toast('Could not open'); }
          node.classList.remove('busy');
        };
      } else wrap.classList.add('hidden');
    } catch { wrap.classList.add('hidden'); }
  } else wrap.classList.add('hidden');
}

function toggleFav(it) {
  if (!it) return;
  if (isFav(it.id)) {
    state.favs = state.favs.filter(x => x.id !== it.id);
    toast('Removed from favourites');
  } else {
    state.favs = [{ ...it, when: undefined }, ...state.favs].slice(0, 500);
    toast('Added to favourites');
  }
  store.set('kanade.favs', state.favs);
  const c = cur();
  if (c) $('#btnFav').classList.toggle('on', isFav(c.id));
}

/* ---------- history ---------- */
function renderHistory() {
  const el = $('#historyList');
  $('#historyEmpty').style.display = state.history.length ? 'none' : 'block';
  el.innerHTML = state.history.map((it, i) => rowHTML(it, i)).join('');
  hydrateArt(el);
  bindList(el, state.history);
}
$('#clearHistory').addEventListener('click', () => {
  state.history = [];
  store.set('kanade.history', state.history);
  renderHistory();
  toast('History cleared');
});

function pushHistory(it) {
  if (!$('#keepHistory').checked) return;
  const when = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  state.history = [{ ...it, when }, ...state.history].slice(0, 1000);
  store.set('kanade.history', state.history);
}
function pushRecent(it) {
  state.recents = [it, ...state.recents.filter(x => x.id !== it.id)].slice(0, 60);
  store.set('kanade.recents', state.recents);
}

/* ---------- playback ---------- */
async function playList(items, index) {
  state.queue = items.slice();
  state.index = index;
  if (state.shuffle) applyShuffle(true);
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
    $('#fmtBadge').textContent = `${codec} · ${Math.round((meta.bitrate || 0) / 1000)} kbps`;
    // Play through the Rust stream proxy: googlevideo rejects the webview's
    // own fetch (UA mismatch with the client that issued the URL).
    audio.src = await registerStream(t.id, meta.url, meta.ua);
    audio.playbackRate = state.speed;
    await audio.play();
    if (my !== playToken) return;
    pushRecent(t);
    pushHistory(t);
    loadLyrics(t, meta);
    setMediaSession(t);
  } catch {
    if (my !== playToken) return;
    setPlayIcon();
    errorStreak++;
    if (errorStreak >= 3) {
      toast('Playback keeps failing — stopped. Check Settings → Diagnostics.');
      return;
    }
    toast(`Couldn't play "${t.title}" — skipping`);
    next(true);
  }
}

function setNowPlayingUI(t) {
  $('#miniPlayer').classList.remove('hidden');
  $('#miniTitle').textContent = t.title;
  $('#miniArtist').textContent = t.artist;
  $('#playerTitle').textContent = t.title;
  $('#playerArtist').textContent = t.artist;
  $('#fmtBadge').textContent = '…';
  $('#btnFav').classList.toggle('on', isFav(t.id));
  setImg($('#miniArt'), t.thumb);
  setImg($('#playerArt'), t.thumb);
  getArt(t.thumb).then(u => { $('#playerBg').style.backgroundImage = `url("${u}")`; });
  applyAccent(t.thumb);
  document.title = `${t.title} — ${t.artist} · KanadeTune`;
  document.querySelectorAll('.songRow, .qpCard').forEach(r => r.classList.toggle('playing', r.dataset.id === t.id));
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

function next(fromError) {
  if (state.repeat === 2 && !fromError) { audio.currentTime = 0; audio.play(); return; }
  if (state.index < state.queue.length - 1) { state.index++; playCurrent(); }
  else if (state.repeat === 1 && state.queue.length) { state.index = 0; playCurrent(); }
}
function prev() {
  if (audio.currentTime > 4) { audio.currentTime = 0; return; }
  if (state.index > 0) { state.index--; playCurrent(); }
}

audio.addEventListener('ended', () => next());
audio.addEventListener('play', () => { state.playing = true; errorStreak = 0; setPlayIcon(); });
audio.addEventListener('pause', () => { state.playing = false; setPlayIcon(); });
audio.addEventListener('error', () => {
  if (!audio.src) return;
  errorStreak++;
  if (errorStreak >= 3) {
    toast('Playback keeps failing — stopped. Check Settings → Diagnostics.');
    setPlayIcon();
    return; // brake: don't machine-gun through the whole queue
  }
  next(true);
});

function setMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist,
    artwork: t.thumb ? [{ src: t.thumb, sizes: '512x512' }] : []
  });
  navigator.mediaSession.setActionHandler('play', togglePlay);
  navigator.mediaSession.setActionHandler('pause', togglePlay);
  navigator.mediaSession.setActionHandler('nexttrack', () => next());
  navigator.mediaSession.setActionHandler('previoustrack', prev);
}

/* ---------- shuffle / repeat / speed / sleep ---------- */
function applyShuffle(keepCurrent) {
  const c = keepCurrent ? cur() : null;
  const rest = state.queue.filter((_, i) => i !== state.index);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  state.queue = c ? [c, ...rest] : rest;
  state.index = 0;
  renderQueue();
}
$('#btnShuffle').addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  $('#btnShuffle').classList.toggle('on', state.shuffle);
  if (state.shuffle && state.queue.length) { applyShuffle(true); toast('Shuffle on'); }
  else toast('Shuffle off');
});
$('#btnRepeat').addEventListener('click', () => {
  state.repeat = (state.repeat + 1) % 3;
  const b = $('#btnRepeat');
  b.classList.toggle('on', state.repeat > 0);
  b.classList.toggle('on1', state.repeat === 2);
  toast(['Repeat off', 'Repeat all', 'Repeat one'][state.repeat]);
});

const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
$('#btnSpeed').addEventListener('click', () => {
  const i = (SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length;
  state.speed = SPEEDS[i];
  audio.playbackRate = state.speed;
  $('#btnSpeed').textContent = state.speed.toFixed(2).replace(/0+$/, '').replace(/\.$/, '.0') + '×';
});

const SLEEPS = [null, 15, 30, 60];
let sleepIdx = 0;
$('#btnSleep').addEventListener('click', () => {
  sleepIdx = (sleepIdx + 1) % SLEEPS.length;
  const m = SLEEPS[sleepIdx];
  state.sleepAt = m ? Date.now() + m * 60000 : null;
  $('#btnSleep').textContent = m ? `Sleep ${m}m` : 'Sleep';
  $('#btnSleep').classList.toggle('on', !!m);
  toast(m ? `Sleeping in ${m} minutes` : 'Sleep timer off');
});

$('#btnFav').addEventListener('click', () => toggleFav(cur()));

/* ---------- rAF loop ---------- */
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
    if (state.sleepAt && Date.now() > state.sleepAt) {
      audio.pause();
      state.sleepAt = null; sleepIdx = 0;
      $('#btnSleep').textContent = 'Sleep';
      $('#btnSleep').classList.remove('on');
      toast('Sleep timer: paused. Good night 🌙');
    }
  }
  if (state.lyricsOn && state.lyrics?.lines) syncLyrics(pos);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ---------- seek / volume ---------- */
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

$('#vol').value = Math.round(audio.volume * 100);
$('#vol').addEventListener('input', (e) => {
  audio.volume = e.target.value / 100;
  if ($('#rememberVol').checked) localStorage.setItem('kanade.vol', audio.volume);
});

/* ---------- player open/close ---------- */
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
$('#btnNext').addEventListener('click', () => next());
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
  if (!state.queueOn) $('#queueList').innerHTML = '';
  else renderQueue();
}

function renderQueue() {
  if (!state.queueOn) return;
  const el = $('#queueList');
  el.innerHTML = state.queue.map((it, i) => rowHTML(it, i)).join('');
  hydrateArt(el);
  el.querySelectorAll('.songRow').forEach(r => r.classList.toggle('playing', +r.dataset.i === state.index));
  el.onclick = (e) => {
    const favBtn = e.target.closest('[data-fav]');
    if (favBtn) {
      const it = state.queue.find(x => x.id === favBtn.dataset.fav);
      toggleFav(it);
      favBtn.classList.toggle('on', isFav(favBtn.dataset.fav));
      return;
    }
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

/* ---------- account (Google sign-in) ---------- */
function refreshAccountUI() {
  const signed = ytm.isSignedIn();
  $('#accountState').textContent = signed ? 'Signed in with Google' : 'Not signed in';
  $('#btnAuth').textContent = signed ? 'Sign out' : 'Sign in with Google';
}

let authInFlight = false;
async function startSignIn() {
  if (authInFlight) return;
  authInFlight = true;
  const codeRow = $('#authCodeRow');
  try {
    await auth.signIn(({ url, code }) => {
      codeRow.style.display = '';
      $('#authUrl').textContent = url.replace(/^https?:\/\//, '');
      $('#authCode').textContent = code;
      $('#btnAuthOpen').onclick = () => openUrl(url);
      openUrl(url);
    });
    codeRow.style.display = 'none';
    await ytm.reinit();
    refreshAccountUI();
    toast('Signed in! Loading your feed…');
    loadHome();
  } catch (e) {
    codeRow.style.display = 'none';
    toast('Sign-in failed: ' + (e?.message || 'unknown error'));
  } finally {
    authInFlight = false;
  }
}

$('#btnAuth').addEventListener('click', async () => {
  if (ytm.isSignedIn()) {
    await auth.signOut();
    localStorage.removeItem('kanade.cookie');
    await ytm.reinit();
    refreshAccountUI();
    toast('Signed out');
    loadHome();
  } else {
    startSignIn();
  }
});

/* ---------- region ---------- */
function refreshRegionUI() {
  $('#regionSel').value = localStorage.getItem('kanade.region') || 'auto';
  const geo = localStorage.getItem('kanade.geo');
  $('#regionNow').textContent = geo ? `Detected: ${geo}.` : '';
}
$('#regionSel').addEventListener('change', async (e) => {
  localStorage.setItem('kanade.region', e.target.value);
  if (e.target.value === 'auto') localStorage.removeItem('kanade.geo');
  await ytm.reinit();
  toast('Region updated — refreshing feed');
  loadHome();
});

/* ---------- settings: cache ---------- */
const capSel = $('#cacheCap');
capSel.value = String(Math.round(capBytes() / 1024 / 1024));
if (!capSel.value || capSel.value === '0') capSel.value = '100';
capSel.addEventListener('change', () => { setCapMB(+capSel.value); refreshCacheUsage(); });
$('#clearCache').addEventListener('click', async () => { await clearAll(); refreshCacheUsage(); toast('Artwork cache cleared'); });
async function refreshCacheUsage() {
  const b = await usageBytes();
  $('#cacheUsage').textContent = `${(b / 1024 / 1024).toFixed(1)} MB of ${capSel.value} MB used`;
}

/* ---------- diagnostics ---------- */
$('#btnDiag').addEventListener('click', async () => {
  const out = $('#diagOut');
  out.textContent = 'Testing…';
  try {
    const { probe } = await import('./tfetch.js');
    const r = await probe();
    out.textContent = JSON.stringify(r, null, 1);
  } catch (e) {
    out.textContent = 'Probe failed: ' + (e?.message || e);
  }
});

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
refreshAccountUI();
loadHome();
