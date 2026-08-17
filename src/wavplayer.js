// wavplayer.js — Web Audio playback engine for WAV (PCM16) data.
// Exists because on some Windows systems (N editions / missing Media Feature
// Pack) the HTML media element cannot play ANY format (SRC_NOT_SUPPORTED for
// mp4, webm, everything) while fetch() and Web Audio work fine. This engine
// parses WAV manually (no decodeAudioData, no OS codecs) and renders through
// AudioContext -> WASAPI. Dependencies: none.
import { dlog } from './debuglog.js';

// Parse a 16-bit PCM WAV file. Returns { sampleRate, channels, pcm: Int16Array }.
export function parseWav(buf) {
  const dv = new DataView(buf);
  const tag = (off) => String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12;
  let fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= dv.byteLength) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: dv.getUint16(off + 8, true),
        channels: dv.getUint16(off + 10, true),
        sampleRate: dv.getUint32(off + 12, true),
        bitsPerSample: dv.getUint16(off + 22, true)
      };
    } else if (id === 'data') {
      dataOff = off + 8;
      dataLen = Math.min(size, dv.byteLength - dataOff);
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || dataOff < 0) throw new Error('WAV missing fmt/data chunk');
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) throw new Error(`unsupported WAV: fmt=${fmt.audioFormat} bits=${fmt.bitsPerSample}`);
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    pcm: new Int16Array(buf, dataOff, Math.floor(dataLen / 2))
  };
}

export class WavEngine {
  constructor() {
    this.ctx = null;
    this.gainNode = null;
    this.buffer = null;   // AudioBuffer
    this.source = null;   // current AudioBufferSourceNode
    this.offset = 0;      // seconds into the buffer when (re)started
    this.startCtxTime = 0;
    this.playing = false;
    this._volume = 1;
    this._rate = 1;
    this.onended = null;
    this.active = false;  // whether this engine owns current playback
  }

  _ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gainNode = this.ctx.createGain();
      this.gainNode.connect(this.ctx.destination);
      this.gainNode.gain.value = this._volume;
    }
    return this.ctx;
  }

  async load(url) {
    const ctx = this._ensureCtx();
    this.stopSource();
    this.buffer = null;
    this.offset = 0;
    const res = await fetch(url);
    if (!res.ok) throw new Error('wav fetch ' + res.status);
    const raw = await res.arrayBuffer();
    const { sampleRate, channels, pcm } = parseWav(raw);
    const frames = Math.floor(pcm.length / channels);
    const buf = ctx.createBuffer(channels, frames, sampleRate);
    // Deinterleave PCM16 -> Float32 channels.
    for (let ch = 0; ch < channels; ch++) {
      const out = buf.getChannelData(ch);
      for (let i = 0; i < frames; i++) out[i] = pcm[i * channels + ch] / 32768;
    }
    this.buffer = buf;
    dlog('wav: loaded', frames, 'frames @', sampleRate, 'Hz,', channels, 'ch,', (raw.byteLength / 1048576).toFixed(1) + 'MB');
    return buf.duration;
  }

  stopSource() {
    if (this.source) {
      try { this.source.onended = null; this.source.stop(); } catch { /* already stopped */ }
      this.source = null;
    }
  }

  _startAt(offsetSec) {
    const ctx = this._ensureCtx();
    this.stopSource();
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this._rate;
    src.connect(this.gainNode);
    src.onended = () => {
      // natural end only (not manual stop): source still current
      if (this.source === src && this.playing) {
        this.playing = false;
        this.offset = this.duration;
        if (this.onended) this.onended();
      }
    };
    this.offset = offsetSec;
    this.startCtxTime = ctx.currentTime;
    src.start(0, Math.min(offsetSec, Math.max(0, this.buffer.duration - 0.01)));
    this.source = src;
    this.playing = true;
    if (ctx.state === 'suspended') ctx.resume();
  }

  play() {
    if (!this.buffer) return;
    if (this.playing) return;
    this._startAt(this.offset >= this.duration ? 0 : this.offset);
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.currentTime;
    this.playing = false;
    this.stopSource();
  }

  seek(t) {
    if (!this.buffer) return;
    const clamped = Math.min(Math.max(0, t), this.duration);
    if (this.playing) this._startAt(clamped);
    else this.offset = clamped;
  }

  get currentTime() {
    if (!this.buffer) return 0;
    if (!this.playing) return this.offset;
    return Math.min(this.offset + (this.ctx.currentTime - this.startCtxTime) * this._rate, this.duration);
  }

  get duration() { return this.buffer ? this.buffer.duration : 0; }
  get paused() { return !this.playing; }

  set volume(v) {
    this._volume = v;
    if (this.gainNode) this.gainNode.gain.value = v;
  }
  get volume() { return this._volume; }

  set playbackRate(r) {
    this._rate = r;
    if (this.source) this.source.playbackRate.value = r;
  }
  get playbackRate() { return this._rate; }

  dispose() {
    this.stopSource();
    this.buffer = null;
    this.playing = false;
    this.offset = 0;
    this.active = false;
  }
}
