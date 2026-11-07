// Where the Chrome companion keeps its device credential: the refresh credential in local storage (so a browser
// restart doesn't sign you out; revoke it any time in Settings → Devices), the short-lived access credential and
// the day itself in session memory only.
export const DEFAULT_BASE = 'https://pulse.estateautopilots.com/api/native/v0';
export const companionStore = {
  async get() {
    const { companionDevice } = await chrome.storage.local.get('companionDevice');
    if (!companionDevice) return null;
    const { companionAccess } = await chrome.storage.session.get('companionAccess');
    return { ...companionDevice, accessToken: companionAccess ?? '' };
  },
  async set(tokens) {
    const { accessToken, ...device } = tokens;
    await chrome.storage.local.set({ companionDevice: device });
    await chrome.storage.session.set({ companionAccess: accessToken });
  },
  async clear() {
    await chrome.storage.local.remove(['companionDevice', 'companionShown']);
    await chrome.storage.session.remove(['companionAccess', 'companionDay', 'companionPair']);
  },
};
export async function companionBase() {
  const { companionBase: base } = await chrome.storage.local.get('companionBase');
  return base || DEFAULT_BASE;
}
