// Margin - storage layer. Shared by the background worker, content script and extension pages.
// Layout in chrome.storage.local:
//   settings          -> object
//   doc:<docId>       -> { id, type: 'pdf'|'web', title, url, updatedAt, lastPage }
//   hl:<docId>        -> [ highlight, ... ]
//   voc:<id>          -> vocabulary entry (with spaced-repetition state)
//   note:<id>         -> free-standing note
(function (g) {
  'use strict';
  const S = chrome.storage.local;

  // Languages offered for translation (codes as the translation services know them).
  const LANGS = [['vi', 'Vietnamese'], ['en', 'English'], ['ar', 'Arabic'], ['bn', 'Bengali'], ['zh-CN', 'Chinese (Simplified)'], ['zh-TW', 'Chinese (Traditional)'],
    ['nl', 'Dutch'], ['tl', 'Filipino'], ['fr', 'French'], ['de', 'German'], ['hi', 'Hindi'], ['id', 'Indonesian'], ['it', 'Italian'], ['ja', 'Japanese'],
    ['ko', 'Korean'], ['ms', 'Malay'], ['pl', 'Polish'], ['pt', 'Portuguese'], ['ru', 'Russian'], ['es', 'Spanish'], ['th', 'Thai'], ['tr', 'Turkish'], ['uk', 'Ukrainian']];
  // Until the reader chooses: the first language of this browser that is not English (most people read English
  // texts and want their own language back).
  function guessTarget() {
    try {
      for (const tag of (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''])) {
        const t = String(tag).toLowerCase();
        if (!t || t.startsWith('en')) continue;
        if (t.startsWith('zh')) return /tw|hk|mo|hant/.test(t) ? 'zh-TW' : 'zh-CN';
        const base = t.split('-')[0];
        if (base === 'fil') return 'tl';
        if (LANGS.some(l => l[0] === base)) return base;
      }
    } catch (e) { /* no navigator here */ }
    return 'vi';
  }

  const DEFAULTS = {
    targetLang: guessTarget(),
    sourceLang: 'en',
    autoOpenPdf: true,
    webHighlights: false, // Margin is a PDF reader first; highlighting on ordinary web pages is opt-in
    disabledHosts: [],
    cardMode: 'definition', // what a word card leads with: 'definition' | 'translation' | 'both'
    defaultColor: 'yellow',
    markSavedWords: true
  };

  // Four main colors, shared by every document and by both the highlighter and the pen. Each has a name
  // saying what it is used for; the user can rename them. Extra colors live on a single document.
  const PALETTE = [
    { id: 'yellow', hex: '#f5b700', name: 'Main idea' },
    { id: 'green', hex: '#2fb344', name: 'Evidence / example' },
    { id: 'blue', hex: '#2f80ed', name: 'Quote to cite' },
    { id: 'pink', hex: '#e8457f', name: 'Question / unclear' }
  ];
  // Colors that existed before the palette was reduced to four; still shown on documents that use them.
  const LEGACY = { purple: { id: 'purple', hex: '#8a63f5', name: 'Purple' } };
  const COLORS = Object.fromEntries(PALETTE.concat(Object.values(LEGACY)).map(c => [c.id, c.hex]));

  // Colors end up inside style attributes, so only a plain #rrggbb is ever accepted from stored data.
  const okHex = v => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
  const okColor = c => c && typeof c.id === 'string' && okHex(c.hex);
  function globalPalette(settings) {
    const saved = (settings && Array.isArray(settings.palette) ? settings.palette : []).filter(okColor);
    return PALETTE.map(def => {
      const mine = saved.find(c => c.id === def.id);
      return Object.assign({ scope: 'global' }, def, mine ? { hex: mine.hex, name: String(mine.name || def.name).slice(0, 60) } : {});
    });
  }
  // Only web and local addresses are ever opened or fetched; anything else (javascript:, data:, ...) is dropped.
  const safeUrl = u => (typeof u === 'string' && /^(https?|file):/i.test(u.trim()) ? u.trim() : '');
  // Everything selectable on one document: the four main colors, then that document's own colors.
  function paletteFor(settings, docRecord, highlights) {
    const out = globalPalette(settings);
    for (const c of (docRecord && Array.isArray(docRecord.colors) ? docRecord.colors : [])) {
      if (okColor(c) && !out.some(x => x.id === c.id)) out.push({ scope: 'doc', id: c.id, hex: c.hex, name: String(c.name || '').slice(0, 60) });
    }
    for (const hl of highlights || []) {
      if (hl.color && LEGACY[hl.color] && !out.some(x => x.id === hl.color)) out.push(Object.assign({ scope: 'doc' }, LEGACY[hl.color]));
    }
    return out;
  }
  function colorOf(palette, id) {
    return (palette || []).find(c => c.id === id) || LEGACY[id] || (palette && palette[0]) || PALETTE[0];
  }
  // Lightens a color toward white (amount 0..1) - used where a solid, readable background is needed.
  function tint(hex, amount) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    const mix = v => Math.round(v + (255 - v) * amount);
    return 'rgb(' + mix((n >> 16) & 255) + ',' + mix((n >> 8) & 255) + ',' + mix(n & 255) + ')';
  }

  const DAY = 86400000;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // cyrb53 string hash -> short hex id
  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }

  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      return u.toString();
    } catch (e) {
      return String(url || '');
    }
  }

  function webDocId(url) {
    return 'web-' + hash(normalizeUrl(url));
  }

  async function get(key) {
    const r = await S.get(key);
    return r[key];
  }

  async function allWithPrefix(prefix) {
    const all = await S.get(null);
    const out = [];
    for (const k in all) if (k.startsWith(prefix)) out.push(all[k]);
    return out;
  }

  // ---------- settings ----------
  async function getSettings() {
    return Object.assign({}, DEFAULTS, (await get('settings')) || {});
  }
  // Settings that describe how you work (shared between your computers when sync is on); the rest,
  // such as zoom or page theme, stay with the device.
  const SHARED_SETTINGS = ['palette', 'defaultColor', 'citeStyle', 'targetLang', 'sourceLang', 'ocr', 'reviewMode', 'cardMode'];
  async function setSettings(patch) {
    const s = Object.assign(await getSettings(), patch);
    if (Object.keys(patch).some(k => SHARED_SETTINGS.includes(k))) s.sharedAt = Date.now();
    await S.set({ settings: s });
    return s;
  }

  // Deletions are remembered so that sync does not bring the item back from another computer.
  async function entomb(keys) {
    const tombs = (await get('tombs')) || {};
    const now = Date.now();
    for (const k of keys) tombs[k] = now;
    await S.set({ tombs });
  }

  // ---------- documents ----------
  async function getDoc(id) {
    return get('doc:' + id);
  }
  async function upsertDoc(doc) {
    const prev = (await getDoc(doc.id)) || {};
    const next = Object.assign({ createdAt: Date.now() }, prev, doc, { updatedAt: Date.now() });
    await S.set({ ['doc:' + doc.id]: next });
    return next;
  }
  async function patchDoc(id, patch) {
    const prev = await getDoc(id);
    if (!prev) return null;
    const next = Object.assign(prev, patch, { updatedAt: Date.now() });
    await S.set({ ['doc:' + id]: next });
    return next;
  }
  async function listDocs() {
    const docs = await allWithPrefix('doc:');
    return docs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  // Adds or updates one of a document's own colors (creating the library entry if needed).
  async function saveDocColor(doc, color) {
    const prev = (await getDoc(doc.id)) || {};
    const colors = (prev.colors || []).filter(c => c.id !== color.id);
    const item = { id: color.id || 'c-' + uid(), hex: color.hex, name: color.name };
    colors.push(item);
    await upsertDoc(Object.assign({}, doc, { colors }));
    return item;
  }
  async function removeDocColor(docId, colorId) {
    const prev = await getDoc(docId);
    if (prev) await patchDoc(docId, { colors: (prev.colors || []).filter(c => c.id !== colorId) });
  }
  async function saveGlobalColor(id, patch) {
    const settings = await getSettings();
    const palette = globalPalette(settings).map(c => (c.id === id ? Object.assign({}, c, patch) : c))
      .map(c => ({ id: c.id, hex: c.hex, name: c.name }));
    return setSettings({ palette });
  }
  async function removeDoc(id) {
    await S.remove(['doc:' + id, 'hl:' + id, 'cite:' + id]);
    await entomb(['doc:' + id, 'cite:' + id]);
  }

  // ---------- highlights ----------
  async function getHighlights(docId) {
    return (await get('hl:' + docId)) || [];
  }
  async function saveHighlights(docId, list) {
    await S.set({ ['hl:' + docId]: list });
  }
  // doc: { id, type, title, url } - registered in the library when its first highlight is added
  async function addHighlight(doc, hl) {
    const list = await getHighlights(doc.id);
    const item = Object.assign({ id: uid(), kind: 'highlight', color: 'yellow', note: '', createdAt: Date.now() }, hl);
    list.push(item);
    await saveHighlights(doc.id, list);
    await upsertDoc(doc);
    return item;
  }
  async function updateHighlight(docId, id, patch) {
    const list = await getHighlights(docId);
    const item = list.find(h => h.id === id);
    if (!item) return null;
    Object.assign(item, patch, { updatedAt: Date.now() });
    await saveHighlights(docId, list);
    return item;
  }
  async function removeHighlight(docId, id) {
    const list = await getHighlights(docId);
    await saveHighlights(docId, list.filter(h => h.id !== id));
    await entomb(['hl:' + docId + ':' + id]);
  }

  // ---------- vocabulary ----------
  function normTerm(t) {
    return String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }
  async function listVocab() {
    const list = await allWithPrefix('voc:');
    return list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  async function findVocab(term) {
    const key = normTerm(term);
    return (await listVocab()).find(v => normTerm(v.term) === key) || null;
  }
  // Adds a word, or merges a new context sentence into an existing entry for the same word.
  async function saveVocab(entry) {
    const existing = await findVocab(entry.term);
    if (existing) {
      const ctx = (entry.contexts || [])[0];
      if (ctx && ctx.sentence && !(existing.contexts || []).some(c => c.sentence === ctx.sentence)) {
        existing.contexts = (existing.contexts || []).concat(ctx).slice(-5);
        existing.updatedAt = Date.now();
      }
      await S.set({ ['voc:' + existing.id]: existing });
      return existing;
    }
    const now = Date.now();
    const item = Object.assign(
      {
        id: uid(), term: '', translation: '', alts: [], phonetic: '', defs: [], contexts: [], createdAt: now,
        srs: { reps: 0, lapses: 0, interval: 0, ease: 2.5, due: now }
      },
      entry
    );
    await S.set({ ['voc:' + item.id]: item });
    return item;
  }
  async function updateVocab(id, patch) {
    const item = await get('voc:' + id);
    if (!item) return null;
    Object.assign(item, patch, { updatedAt: Date.now() });
    await S.set({ ['voc:' + id]: item });
    return item;
  }
  async function removeVocab(id) {
    await S.remove('voc:' + id);
    await entomb(['voc:' + id]);
  }

  // Spaced repetition (SM-2 style). grade: 0 again, 1 hard, 2 good, 3 easy.
  function schedule(srs, grade, now) {
    now = now || Date.now();
    const s = Object.assign({ reps: 0, lapses: 0, interval: 0, ease: 2.5, due: now }, srs);
    if (grade === 0) {
      s.reps = 0;
      s.lapses += 1;
      s.interval = 0;
      s.ease = Math.max(1.3, s.ease - 0.2);
      s.due = now + 10 * 60000;
      return s;
    }
    let interval;
    if (s.reps === 0) interval = grade === 3 ? 4 : grade === 2 ? 1 : 0.5;
    else if (s.reps === 1) interval = grade === 3 ? 7 : grade === 2 ? 3 : 1.5;
    else interval = s.interval * (grade === 3 ? s.ease * 1.3 : grade === 2 ? s.ease : 1.2);
    if (grade === 1) s.ease = Math.max(1.3, s.ease - 0.15);
    if (grade === 3) s.ease = Math.min(3.0, s.ease + 0.15);
    s.reps += 1;
    s.interval = Math.round(interval * 100) / 100;
    s.due = now + s.interval * DAY;
    return s;
  }
  function describeInterval(srs, grade) {
    const now = Date.now();
    const ms = schedule(srs, grade, now).due - now;
    if (ms < 3600000) return Math.round(ms / 60000) + ' min';
    if (ms < DAY) return Math.round(ms / 3600000) + ' h';
    const d = ms / DAY;
    if (d < 30) return Math.round(d) + ' d';
    if (d < 365) return Math.round(d / 30) + ' mo';
    return (d / 365).toFixed(1) + ' y';
  }
  async function dueVocab(now) {
    now = now || Date.now();
    return (await listVocab()).filter(v => (v.srs ? v.srs.due : 0) <= now).sort((a, b) => a.srs.due - b.srs.due);
  }

  // ---------- notes ----------
  async function listNotes() {
    const list = await allWithPrefix('note:');
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  async function saveNote(note) {
    const now = Date.now();
    const item = Object.assign({ id: uid(), title: '', body: '', createdAt: now }, note, { updatedAt: now });
    await S.set({ ['note:' + item.id]: item });
    return item;
  }
  async function removeNote(id) {
    await S.remove('note:' + id);
    await entomb(['note:' + id]);
  }

  // ---------- backup ----------
  async function exportAll() {
    const data = await S.get(null);
    for (const k in data) if (k.startsWith('_') || k.startsWith('ocr:')) delete data[k]; // internal bookkeeping and re-creatable caches
    return { app: 'margin', version: 1, exportedAt: new Date().toISOString(), data };
  }
// Combines two copies of the library (this computer's and another's) into one, key by key:
  // the newer version of each item wins, highlights are merged one by one, and anything deleted on
  // either side stays deleted. Pure function - used by Import and by sync.
  const stamp = x => (x && (x.updatedAt || x.createdAt || x.at)) || 0;
  // A backup or sync file comes from outside this browser. Before it is trusted, keep only the kinds of
  // record Margin itself writes, in the shape it writes them; everything else in the file is ignored.
  function sanitize(data) {
    const out = {};
    const obj = v => v && typeof v === 'object' && !Array.isArray(v);
    if (!obj(data)) return out;
    for (const key of Object.keys(data)) {
      const v = data[key];
      if (key === 'settings') {
        if (obj(v)) out.settings = Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_') && !k.startsWith('debug')));
      } else if (key === 'tombs') {
        if (obj(v)) out.tombs = Object.fromEntries(Object.entries(v).filter(([, t]) => typeof t === 'number'));
      } else if (key.startsWith('hl:')) {
        if (Array.isArray(v)) out[key] = v.filter(x => obj(x) && typeof x.id === 'string');
      } else if (key.startsWith('doc:')) {
        if (obj(v) && typeof v.id === 'string' && 'doc:' + v.id === key) out[key] = Object.assign({}, v, { url: safeUrl(v.url) });
      } else if (key.startsWith('voc:')) {
        if (obj(v) && typeof v.id === 'string' && typeof v.term === 'string' && obj(v.srs)) out[key] = v;
      } else if (key.startsWith('note:')) {
        if (obj(v) && typeof v.id === 'string') out[key] = Object.assign({}, v, { sourceUrl: safeUrl(v.sourceUrl) });
      } else if (key.startsWith('cite:')) {
        if (obj(v) && obj(v.meta)) out[key] = v;
      }
    }
    return out;
  }
  function mergeData(local, remote) {
    local = local || {};
    remote = sanitize(remote);
    const out = {};
    const tombs = Object.assign({}, remote.tombs || {});
    for (const k in local.tombs || {}) tombs[k] = Math.max(tombs[k] || 0, local.tombs[k]);
    const cutoff = Date.now() - 180 * DAY;
    for (const k in tombs) if (tombs[k] < cutoff) delete tombs[k];
    const dead = (key, item) => (tombs[key] || 0) >= stamp(item);

    const keys = new Set(Object.keys(local).concat(Object.keys(remote)));
    for (const key of keys) {
      if (key === 'tombs' || key.startsWith('_') || key.startsWith('ocr:')) continue;
      const a = local[key], b = remote[key];
      if (key === 'settings') {
        const merged = Object.assign({}, a || {});
        if (b && (b.sharedAt || 0) > ((a && a.sharedAt) || 0)) {
          for (const f of SHARED_SETTINGS) if (b[f] !== undefined) merged[f] = b[f];
          merged.sharedAt = b.sharedAt;
        }
        out.settings = merged;
      } else if (key.startsWith('hl:')) {
        const docId = key.slice(3);
        const byId = new Map();
        for (const item of [].concat(Array.isArray(b) ? b : [], Array.isArray(a) ? a : [])) {
          const prev = byId.get(item.id);
          if (!prev || stamp(item) >= stamp(prev)) byId.set(item.id, item); // local listed last, so it wins ties
        }
        const list = [...byId.values()].filter(item => !dead('hl:' + docId + ':' + item.id, item) && !dead('doc:' + docId, item))
          .sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0) || String(x.id).localeCompare(String(y.id)));
        if (list.length || !tombs['doc:' + docId]) out[key] = list;
      } else {
        const pick = !b ? a : !a ? b : stamp(b) > stamp(a) ? b : a;
        if (pick && !dead(key, pick)) out[key] = pick;
      }
    }
    // The same word saved on two computers: keep the more-studied card and both sets of example sentences.
    const words = new Map();
    for (const key of Object.keys(out)) {
      if (!key.startsWith('voc:')) continue;
      const v = out[key], t = normTerm(v.term), other = words.get(t);
      if (!other) { words.set(t, key); continue; }
      const o = out[other];
      const keepNew = ((v.srs && v.srs.reps) || 0) > ((o.srs && o.srs.reps) || 0) || (((v.srs && v.srs.reps) || 0) === ((o.srs && o.srs.reps) || 0) && key < other);
      const keep = keepNew ? v : o, drop = keepNew ? o : v;
      const seen = new Set((keep.contexts || []).map(c => c.sentence));
      const extra = (drop.contexts || []).filter(c => !seen.has(c.sentence));
      // a fresh copy, never the caller's object: the caller compares before and after
      if (extra.length) out[keepNew ? key : other] = Object.assign({}, keep, { contexts: (keep.contexts || []).concat(extra).slice(-5), updatedAt: Date.now() });
      delete out[keepNew ? other : key];
      tombs[keepNew ? other : key] = Date.now();
      words.set(t, keepNew ? key : other);
    }
    if (Object.keys(tombs).length) out.tombs = tombs;
    return out;
  }

  async function importAll(payload, replace) {
    if (!payload || payload.app !== 'margin' || !payload.data) throw new Error('Not a Margin backup file');
    if (replace) {
      await S.clear();
      await S.set(sanitize(payload.data));
      return;
    }
    const current = await S.get(null);
    const merged = mergeData(current, payload.data);
    const gone = Object.keys(current).filter(k => !(k in merged) && !k.startsWith('_') && !k.startsWith('ocr:'));
    if (gone.length) await S.remove(gone);
    await S.set(merged);
  }

  g.MarginStore = {
    DEFAULTS, LANGS, COLORS, PALETTE, DAY, uid, hash, normalizeUrl, webDocId, normTerm, safeUrl, sanitize,
    globalPalette, paletteFor, colorOf, tint, saveDocColor, removeDocColor, saveGlobalColor,
    getSettings, setSettings,
    getDoc, upsertDoc, patchDoc, listDocs, removeDoc,
    getHighlights, saveHighlights, addHighlight, updateHighlight, removeHighlight,
    listVocab, findVocab, saveVocab, updateVocab, removeVocab, schedule, describeInterval, dueVocab,
    listNotes, saveNote, removeNote,
    exportAll, importAll, mergeData, SHARED_SETTINGS
  };
})(globalThis);
