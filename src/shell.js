// External-link opener. Uses our Rust open_url command (most reliable),
// falling back to the opener plugin JS API, then window.open.
import { invoke } from '@tauri-apps/api/core';

export async function openUrl(url) {
  if (!/^https?:\/\//.test(String(url))) return;
  try {
    await invoke('open_url', { url });
    return;
  } catch { /* fall through */ }
  try {
    const { openUrl: o } = await import('@tauri-apps/plugin-opener');
    await o(url);
    return;
  } catch { /* fall through */ }
  try { window.open(url, '_blank', 'noopener'); } catch { /* give up */ }
}
