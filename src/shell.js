// Minimal external-link opener via Tauri's opener plugin, with web fallback.
export async function openUrl(url) {
  if (!/^https?:\/\//.test(String(url))) return;
  try {
    const { openUrl: o } = await import('@tauri-apps/plugin-opener');
    await o(url);
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}
