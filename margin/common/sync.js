// Margin - optional sync between your own computers through a folder that a cloud drive keeps in step
// (OneDrive, Google Drive, Dropbox...). Margin keeps one file there, margin-sync.json, and merges it with
// this computer's library: newer edits win, deletions stay deleted. Nothing is sent anywhere by Margin itself.
(function (g) {
  'use strict';
  const Store = g.MarginStore;
  const FILE = 'margin-sync.json';
  let running = false, timer = null, testHandle = null;

  const supported = () => typeof g.showDirectoryPicker === 'function' || !!testHandle;

  // The chosen folder is remembered in IndexedDB (handles cannot be stored anywhere else).
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('margin-sync', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('kv', mode);
        const req = fn(tx.objectStore('kv'));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }
  // Same data, same text - whatever order the fields happen to be stored in.
  const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? Object.fromEntries(Object.keys(x).sort().map(n => [n, x[n]])) : x);

  const loadHandle = async () => testHandle || (await idb('readonly', s => s.get('dir')).catch(() => null)) || null;

  async function permission(handle, ask) {
    if (!handle.queryPermission) return 'granted';
    let p = await handle.queryPermission({ mode: 'readwrite' });
    if (p !== 'granted' && ask) p = await handle.requestPermission({ mode: 'readwrite' });
    return p;
  }

  async function setState(patch) {
    const prev = (await chrome.storage.local.get('_sync'))._sync || {};
    await chrome.storage.local.set({ _sync: Object.assign(prev, patch) });
  }

  // -> { ok, reason?, pulled, pushed }
  async function run(opts) {
    opts = opts || {};
    if (running) return { ok: false, reason: 'busy' };
    const handle = await loadHandle();
    if (!handle) return { ok: false, reason: 'off' };
    running = true;
    try {
      const perm = await permission(handle, opts.interactive);
      if (perm !== 'granted') {
        await setState({ paused: true });
        return { ok: false, reason: 'permission' };
      }
      const fh = await handle.getFileHandle(FILE, { create: true });
      const text = await (await fh.getFile()).text();
      let remote = {};
      if (text.trim()) {
        const parsed = JSON.parse(text);
        if (parsed.app !== 'margin' || !parsed.data) throw new Error(FILE + ' in that folder is not a Margin file');
        remote = parsed.data;
      }
      const local = (await Store.exportAll()).data;
      const merged = Store.mergeData(local, remote);

      // what this computer is missing
      const toSet = {}, toRemove = [];
      for (const k in merged) if (canon(merged[k]) !== canon(local[k])) toSet[k] = merged[k];
      for (const k in local) if (!(k in merged)) toRemove.push(k);
      if (toRemove.length) await chrome.storage.local.remove(toRemove);
      if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);

      // what the shared file is missing (device-only settings are left out of the comparison)
      const shared = d => {
        const c = Object.assign({}, d);
        if (c.settings) c.settings = Object.fromEntries(Object.entries(c.settings).filter(([k]) => Store.SHARED_SETTINGS.includes(k) || k === 'sharedAt').sort((x, y) => (x[0] < y[0] ? -1 : 1)));
        return c;
      };
      const out = shared(merged), was = shared(remote);
      const keys = new Set(Object.keys(out).concat(Object.keys(was)));
      let pushed = false;
      for (const k of keys) if (canon(out[k]) !== canon(was[k])) { pushed = true; break; }
      if (pushed) {
        const w = await fh.createWritable();
        await w.write(JSON.stringify({ app: 'margin', version: 1, sync: true, exportedAt: new Date().toISOString(), data: out }));
        await w.close();
      }
      const pulled = Object.keys(toSet).length + toRemove.length;
      await setState({ at: Date.now(), paused: false, error: '', folder: handle.name || '' });
      return { ok: true, pulled, pushed };
    } catch (e) {
      await setState({ error: String(e && e.message || e), errorAt: Date.now() });
      return { ok: false, reason: String(e && e.message || e) };
    } finally {
      running = false;
    }
  }

  async function choose() {
    const handle = await g.showDirectoryPicker({ id: 'margin-sync', mode: 'readwrite' });
    await idb('readwrite', s => s.put(handle, 'dir'));
    await setState({ folder: handle.name, paused: false, error: '' });
    return run({ interactive: true });
  }
  async function disconnect() {
    await idb('readwrite', s => s.delete('dir')).catch(() => {});
    await chrome.storage.local.remove('_sync');
  }
  async function status() {
    const handle = await loadHandle();
    const state = (await chrome.storage.local.get('_sync'))._sync || {};
    return { supported: supported(), connected: !!handle, folder: (handle && handle.name) || state.folder || '', at: state.at || 0, paused: !!state.paused, error: state.error || '' };
  }

  // Keeps things in step while a Margin page is open: once on load, shortly after any change, and every few minutes.
  function start(onPaused) {
    const tick = async () => {
      const r = await run();
      if (!r.ok && r.reason === 'permission' && onPaused) onPaused();
    };
    loadHandle().then(h => {
      if (!h) return;
      tick();
      setInterval(tick, 4 * 60000);
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || running) return;
        if (!Object.keys(changes).some(k => !k.startsWith('_') && !k.startsWith('ocr:'))) return;
        clearTimeout(timer);
        timer = setTimeout(tick, 15000);
      });
    });
  }

  // Small button shown when the browser wants the folder permission confirmed again.
  function pill(text, onClick) {
    if (document.getElementById('mg-syncpill')) return;
    const b = document.createElement('button');
    b.id = 'mg-syncpill';
    b.textContent = text;
    b.style.cssText = 'position:fixed;left:16px;bottom:60px;z-index:2147483000;border:1px solid #c9a227;border-radius:999px;padding:8px 14px;' +
      'background:#fff8dc;color:#5b4500;font:600 12px system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 22px rgba(0,0,0,.25)';
    b.addEventListener('click', () => { b.remove(); onClick(); });
    document.body.appendChild(b);
  }

  g.MarginSync = { supported, run, choose, disconnect, status, start, pill, FILE, _useHandle: h => { testHandle = h; } };
})(globalThis);
