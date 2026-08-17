# ♪ KanadeTune

**奏でる — to play music.** A light, cute, portable desktop player for **YouTube Music** — no backend, no ads, no account required. Built with **Tauri 2** for a tiny footprint that low-end laptops can love.

> Inspired by [ArchiveTune](https://github.com/rukamori/ArchiveTune) 🌸 by rukamori & contributors.

## ✨ Features

- 🔍 Search YouTube Music (songs + videos, with general-video fallback)
- 🏠 Region-aware home feed (auto-detected from your IP, overridable) with MD3 quick-pick cards and playlist shelves
- ▶️ Flat, clean player — album-art accent color, **zero glass/blur effects**, compositor-only animations at your display's native refresh rate
- 🔐 **Google sign-in** (TV device-code flow — no client secret shipped) for your playlists, likes and personal mixes
- 🕘 Full listening **History** (with privacy toggle + clear), Favourites, and Recently played
- 🔀 Shuffle, repeat (all/one), playback **speed control**, **sleep timer**
- 💬 Synced lyrics (LRCLIB) with click-to-seek; plain-lyrics fallback from YT Music
- ⏭ Auto "Up next" radio queue
- 🗃 **Size-capped artwork cache** (LRU, 50–500 MB, user-configurable in Settings, one-click clear)
- 🎚 Media-key support, remembered volume, recently-played library
- 🪶 ~10–15 MB installer, ~100–180 MB RAM (WebView2 — no bundled Chromium)

## 🏗 Architecture (no backend)

| Layer | Tech |
|---|---|
| Shell | Tauri 2 (thin Rust core: window + http/global-shortcut/opener plugins) |
| InnerTube | [youtubei.js](https://github.com/LuanRT/YouTube.js) in the WebView; HTTP routed through Rust (`tauri-plugin-http`) → no CORS, requests come from the user's own IP |
| Streams | Playback-client fallback chain: `IOS → ANDROID → TV_EMBEDDED → WEB` |
| Lyrics | [LRCLIB](https://lrclib.net) → YT Music fallback |
| Art cache | IndexedDB LRU with byte cap + in-memory objectURL pool |
| UI | Vanilla HTML/CSS/JS bundled by esbuild — no framework |

## 🚀 Development

Prereqs: Node 18+, Rust (stable), and on Windows the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
npm install
npm run dev        # tauri dev (hot reload)
```

## 📦 Build (Windows)

```bash
npm run build      # bundles JS, then tauri build → NSIS installer in src-tauri/target/release/bundle/
```

CI: pushing to `main` runs the GitHub Actions workflow which produces the Windows installer as an artifact.

## 👤 Team

- **Lead Developer:** [cognitiveshadows](https://github.com/cognitiveshadows03)

## 🙏 Acknowledgments

KanadeTune stands on the shoulders of excellent open-source projects:

- [**ArchiveTune**](https://github.com/rukamori/ArchiveTune) by rukamori & contributors — the design language, lyrics-first philosophy and overall spirit of KanadeTune are directly inspired by it. Go give it a ⭐!
- [**Metrolist**](https://github.com/mostafaalagamy/Metrolist) by mostafaalagamy & contributors — our stream-source strategy (InnerTube playback client definitions, device contexts and priority order in `src/rawplayer.js`) is adapted from Metrolist's battle-tested client work
- [**youtubei.js**](https://github.com/LuanRT/YouTube.js) by LuanRT — the InnerTube library powering browse, search and lyrics
- [**LRCLIB**](https://lrclib.net) — free synced-lyrics API
- [**Symphonia**](https://github.com/pdeljanov/Symphonia) — pure-Rust audio decoding for the AAC→WAV compatibility path

## ⚖️ License & Disclaimer

MIT — see [LICENSE](LICENSE).

KanadeTune is an independent third-party client. Not affiliated with Google LLC or YouTube. It does not bypass any technical protection measures. Please support artists through official channels.
