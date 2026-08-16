// Browser-preview mock of ytm (real YouTube can't be fetched from a browser
// page due to CORS — the real app routes HTTP via Tauri/Rust).
const T = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const AUDIO = [
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3'
];

// All IDs below are real, long-lived music videos => thumbnails resolve.
const SONGS = [
  { id: 'ZRtdQ81jPUQ', title: 'アイドル - Idol', artist: 'YOASOBI', duration: '3:34', thumb: T('ZRtdQ81jPUQ'), type: 'song', playable: true },
  { id: 'xDVsvxWa6bg', title: 'ハルノヒ - Harunohi', artist: 'aimyon', duration: '5:27', thumb: T('xDVsvxWa6bg'), type: 'song', playable: true },
  { id: 'M2cckDmNLMI', title: 'KICK BACK', artist: 'Kenshi Yonezu', duration: '3:13', thumb: T('M2cckDmNLMI'), type: 'song', playable: true },
  { id: 'x8VYWazR5mE', title: '夜に駆ける - Racing Into the Night', artist: 'YOASOBI', duration: '4:23', thumb: T('x8VYWazR5mE'), type: 'song', playable: true },
  { id: 'SX_ViT4Ra7k', title: 'Lemon', artist: 'Kenshi Yonezu', duration: '4:16', thumb: T('SX_ViT4Ra7k'), type: 'song', playable: true },
  { id: 'Y4nEEZwckuU', title: '群青 - Gunjou', artist: 'YOASOBI', duration: '4:07', thumb: T('Y4nEEZwckuU'), type: 'song', playable: true },
  { id: '0xSiBpUdW4E', title: '感電 - Kanden', artist: 'Kenshi Yonezu', duration: '4:04', thumb: T('0xSiBpUdW4E'), type: 'song', playable: true },
  { id: 'by2H9F8dTNw', title: 'マリーゴールド - Marigold', artist: 'aimyon', duration: '4:46', thumb: T('by2H9F8dTNw'), type: 'song', playable: true }
];

export async function home() {
  return [
    { title: 'Quick picks', items: SONGS },
    { title: 'J-Pop essentials', items: [...SONGS].reverse() },
    { title: 'Keep listening', items: SONGS.slice(3).concat(SONGS.slice(0, 3)) }
  ];
}

export async function search(q) {
  await new Promise(r => setTimeout(r, 250));
  const hit = SONGS.filter(s => (s.title + ' ' + s.artist).toLowerCase().includes(q.toLowerCase()));
  return hit.length ? hit : SONGS;
}

export async function expand() { return SONGS; }
export async function library() { return SONGS.slice(0, 4); }
export function isSignedIn() { return false; }
export async function reinit() {}
export function setCookie() {}

export async function stream(id) {
  const i = SONGS.findIndex(s => s.id === id);
  return { url: AUDIO[Math.max(0, i) % AUDIO.length], mime: 'audio/mpeg', bitrate: 128000, durationSec: 214, client: 'PREVIEW' };
}

export async function upNext() { return SONGS; }

export async function lyrics() {
  const lrc = [
    '[00:00.50]KanadeTune preview build',
    '[00:04.00]This is the synced lyrics view',
    '[00:08.00]Each line lights up in time with the music',
    '[00:12.50]Click any line to seek there',
    '[00:17.00]In the real app lyrics come from LRCLIB',
    '[00:21.50]With a plain-text fallback from YouTube Music',
    '[00:26.00]Try shuffle, repeat, speed and the sleep timer',
    '[00:30.50]Favourites live in your Library',
    '[00:35.00]And History keeps everything you played',
    '[00:40.00]奏でる — to play music'
  ].join('\n');
  return { synced: lrc, plain: null, source: 'Preview' };
}
