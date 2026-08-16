// Preview stub for auth.js
export function hasOAuth() { return false; }
export function loadCreds() { return null; }
export function saveCreds() {}
export async function signIn(onCode) {
  onCode?.({ url: 'https://google.com/device', code: 'PREVIEW-CODE' });
  throw new Error('Sign-in works only in the real desktop app');
}
export async function signOut() {}
