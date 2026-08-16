// artcache.js — size-capped LRU cache for album art in IndexedDB.
// Every image the app shows goes through getArt(); when total stored bytes
// exceed the user's cap, least-recently-used entries are evicted.
import { fetch as tfetch } from '@tauri-apps/plugin-http';

const DB = 'kanade-art', STORE = 'art';
const DEFAULT_CAP_MB = 100;

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore(STORE, { keyPath: 'url' });
        s.createIndex('lastUsed', 'lastUsed');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const tx = async (mode) => (await db()).transaction(STORE, mode).objectStore(STORE);
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export function capBytes() {
  return (Number(localStorage.getItem('kanade.cacheCapMB')) || DEFAULT_CAP_MB) * 1024 * 1024;
}
export function setCapMB(mb) {
  localStorage.setItem('kanade.cacheCapMB', String(mb));
  enforceCap().catch(() => {});
}

export async function usageBytes() {
  const store = await tx('readonly');
  let total = 0;
  await new Promise((resolve) => {
    const c = store.openCursor();
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur) return resolve();
      total += cur.value.size || 0;
      cur.continue();
    };
    c.onerror = () => resolve();
  });
  return total;
}

async function enforceCap() {
  const cap = capBytes();
  let total = await usageBytes();
  if (total <= cap) return;
  const store = await tx('readwrite');
  await new Promise((resolve) => {
    const c = store.index('lastUsed').openCursor(); // oldest first
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur || total <= cap * 0.9) return resolve(); // trim to 90% to avoid thrash
      total -= cur.value.size || 0;
      cur.delete();
      cur.continue();
    };
    c.onerror = () => resolve();
  });
}

export async function clearAll() {
  const store = await tx('readwrite');
  await req(store.clear());
  for (const u of urlPool.values()) URL.revokeObjectURL(u);
  urlPool.clear();
}

// url -> objectURL pool so repeated renders reuse blobs already in memory.
const urlPool = new Map();
const inflight = new Map();

export async function getArt(url) {
  if (!url) return '';
  if (urlPool.has(url)) {
    touch(url); // fire-and-forget LRU bump
    return urlPool.get(url);
  }
  if (inflight.has(url)) return inflight.get(url);

  const p = (async () => {
    try {
      const store = await tx('readonly');
      const hit = await req(store.get(url));
      let blob = hit?.blob;
      if (!blob) {
        const res = await tfetch(url);
        if (!res.ok) throw new Error('art http ' + res.status);
        blob = await res.blob();
        const w = await tx('readwrite');
        await req(w.put({ url, blob, size: blob.size, lastUsed: Date.now() }));
        enforceCap().catch(() => {});
      } else {
        touch(url);
      }
      const obj = URL.createObjectURL(blob);
      urlPool.set(url, obj);
      // keep the in-memory pool bounded too (~200 images)
      if (urlPool.size > 200) {
        const first = urlPool.keys().next().value;
        URL.revokeObjectURL(urlPool.get(first));
        urlPool.delete(first);
      }
      return obj;
    } catch {
      return url; // graceful fallback: let <img> hotlink it
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, p);
  return p;
}

async function touch(url) {
  try {
    const store = await tx('readwrite');
    const v = await req(store.get(url));
    if (v) { v.lastUsed = Date.now(); await req(store.put(v)); }
  } catch { /* non-critical */ }
}

// Helper for <img data-art="..."> lazy hydration.
export function hydrateArt(root = document) {
  root.querySelectorAll('img[data-art]').forEach(async (img) => {
    const u = img.dataset.art;
    delete img.dataset.art;
    img.src = await getArt(u);
  });
}
