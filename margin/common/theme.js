// Margin - applies the chosen appearance to an extension page before it paints.
//   device - follow the computer (light or dark)      light - light interface
//   dark   - dark interface, the document untouched   night - dark interface and a darkened page
// The choice lives in settings.uiTheme; a copy in localStorage lets the page pick it up without a flash.
(function (g) {
  'use strict';
  const MODES = ['device', 'light', 'dark', 'night'];
  const OLD = { white: 'light', black: 'dark' }; // names used before version 1.10 ("dark" then meant today's night)
  const media = matchMedia('(prefers-color-scheme: dark)');
  let mode = 'device';
  // Motion: 'system' follows the computer's "reduce motion" setting, 'on' and 'off' override it for Margin.
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  let motion = 'system';
  function paintMotion() {
    const off = motion === 'off' || (motion === 'system' && calm.matches);
    document.documentElement.dataset.motion = off ? 'off' : 'on';
    const host = document.querySelector('margin-ui');
    if (host) host.dataset.motion = off ? 'off' : 'on';
  }
  function applyMotion(next) {
    motion = ['system', 'on', 'off'].includes(next) ? next : 'system';
    try { localStorage.setItem('margin-motion', motion); } catch (e) { /* private mode */ }
    paintMotion();
  }
  function paint() {
    const shown = mode === 'device' ? (media.matches ? 'dark' : 'light') : mode;
    const root = document.documentElement;
    root.dataset.theme = shown;
    root.dataset.ui = shown === 'light' ? 'light' : 'dark';
    const host = document.querySelector('margin-ui');
    if (host) host.dataset.ui = root.dataset.ui;
  }
  function apply(next) {
    mode = MODES.includes(next) ? next : 'device';
    try { localStorage.setItem('margin-mode', mode); } catch (e) { /* private mode */ }
    paint();
  }
  const read = s => {
    if (!s || !s.uiTheme) return 'device';
    if (s.themeV === 2) return s.uiTheme;
    return OLD[s.uiTheme] || (s.uiTheme === 'dark' ? 'night' : 'device');
  };
  let saved = null;
  try { saved = localStorage.getItem('margin-mode'); } catch (e) { /* private mode */ }
  apply(saved);
  media.addEventListener('change', paint);
  let savedMotion = null;
  try { savedMotion = localStorage.getItem('margin-motion'); } catch (e) { /* private mode */ }
  applyMotion(savedMotion);
  calm.addEventListener('change', paintMotion);
  try {
    chrome.storage.local.get('settings').then(r => { const t = read(r.settings); if (t !== mode) apply(t); const m = (r.settings || {}).motion || 'system'; if (m !== motion) applyMotion(m); });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) { const t = read(changes.settings.newValue); if (t !== mode) apply(t); const m = (changes.settings.newValue || {}).motion || 'system'; if (m !== motion) applyMotion(m); }
    });
  } catch (e) { /* not an extension page */ }
  g.MarginTheme = {
    MODES,
    get: () => mode,
    motion: () => motion,
    motionOff: () => document.documentElement.dataset.motion === 'off',
    systemCalm: () => calm.matches,
    async setMotion(next) {
      applyMotion(next);
      const r = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: Object.assign({}, r.settings || {}, { motion }) });
    },
    async set(next) {
      apply(next);
      const r = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: Object.assign({}, r.settings || {}, { uiTheme: mode, themeV: 2 }) });
    }
  };
})(globalThis);
