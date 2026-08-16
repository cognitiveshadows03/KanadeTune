// Browser-preview mock of the ytm service layer (real YouTube data can't be
// fetched from a browser page due to CORS — the real app routes via Tauri/Rust).
const T = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const AUDIO = [
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
  'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3'
];

const SONGS = [
  { id: 'm9SMT5ipbxk', title: 'アイドル - Idol', artist: 'YOASOBI', duration: '3:34', thumb: T('m9SMT5ipbxk'), type: 'song', playable: true },
  { id: 'dF3GDN2P84A', title: 'ハルノヒ - Harunohi', artist: 'aimyon', duration: '5:27', thumb: T('dF3GDN2P84A'), type: 'song', playable: true },
  { id: 'zF2AVDIUIMY', title: 'KICK BACK', artist: 'Kenshi Yonezu', duration: '3:13', thumb: T('zF2AVDIUIMY'), type: 'song', playable: true },
  { id: 'kzZ6KXDM1RI', title: '夜に駆ける - Racing Into the Night', artist: 'YOASOBI', duration: '4:23', thumb: T('kzZ6KXDM1RI'), type: 'song', playable: true },
  { id: 'K3IWm0oyIuo', title: 'Lemon', artist: 'Kenshi Yonezu', duration: '4:16', thumb: T('K3IWm0oyIuo'), type: 'song', playable: true },
  { id: 'HKlHmqgW1U4', title: '群青 - Gunjou', artist: 'YOASOBI', duration: '4:07', thumb: T('HKlHmqgW1U4'), type: 'song', playable: true }
];

export async function home() {
  return [
    { title: 'Quick picks', items: SONGS },
    { title: 'J-Pop essentials', items: [...SONGS].reverse() },
    { title: 'Keep listening', items: SONGS.slice(2).concat(SONGS.slice(0, 2)) }
  ];
}

export async function search(q) {
  await new Promise(r => setTimeout(r, 300));
  return SONGS.filter(s => (s.title + s.artist).toLowerCase().includes(q.toLowerCase())).concat(SONGS);
}

export async function expand() { return SONGS; }

export async function stream(id) {
  const i = SONGS.findIndex(s => s.id === id);
  return {
    url: AUDIO[Math.max(0, i) % AUDIO.length],
    mime: 'audio/mpeg', bitrate: 128000, durationSec: 214, client: 'PREVIEW'
  };
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
    '[00:26.00]Flat surfaces, no glass, no blur',
    '[00:30.50]Animations are compositor-only',
    '[00:35.00]So it stays smooth on low-end laptops',
    '[00:40.00]奏でる — to play music'
  ].join('\n');
  return { synced: lrc, plain: null, source: 'Preview' };
}
