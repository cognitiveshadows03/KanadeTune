// debuglog.js — small in-app ring buffer so on-device failures are visible
// in Settings > Diagnostics without a devtools build.
const MAX = 200;
const buf = [];

export function dlog(...args) {
  const line = new Date().toISOString().slice(11, 23) + ' ' +
    args.map(a => {
      if (a instanceof Error) return a.message;
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
      return String(a);
    }).join(' ');
  buf.push(line);
  if (buf.length > MAX) buf.shift();
  try { console.log('[KT]', ...args); } catch { /* no console */ }
}

export function getLog() { return buf.join('\n'); }
export function clearLog() { buf.length = 0; }
