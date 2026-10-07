// Margin - background service worker.
// Handles: translation/dictionary lookups (cross-origin), deciding when PDFs open in the reader,
// context menus, and the "words due" badge.
importScripts('common/store.js');
const Store = MarginStore;

const READER = chrome.runtime.getURL('reader/reader.html');
const DASHBOARD = chrome.runtime.getURL('pages/dashboard.html');

function readerUrl(fileUrl) {
  return READER + '?file=' + encodeURIComponent(fileUrl);
}

// ---------------------------------------------------------------- lookup
async function fetchJson(url, ms, headers) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms || 5000), credentials: 'omit', headers: headers || {} });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function googleTranslate(text, tl) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + encodeURIComponent(tl) +
    '&dt=t&dt=bd&dt=rm&dj=1&q=' + encodeURIComponent(text);
  const j = await fetchJson(url);
  const sentences = j.sentences || [];
  const translation = sentences.map(s => s.trans || '').join('').trim();
  if (!translation) throw new Error('empty');
  const translit = (sentences.find(s => s.src_translit) || {}).src_translit || '';
  const alts = (j.dict || []).map(d => ({
    pos: d.pos || '',
    terms: (d.terms || (d.entry || []).map(e => e.word)).slice(0, 5)
  })).filter(a => a.terms.length);
  return { translation, alts, src: j.src || '', translit, provider: 'Google Translate' };
}

async function myMemoryTranslate(text, sl, tl) {
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text.slice(0, 480)) +
    '&langpair=' + encodeURIComponent(sl + '|' + tl);
  const j = await fetchJson(url);
  const t = j && j.responseData && j.responseData.translatedText;
  if (!t || /MYMEMORY WARNING|INVALID|QUERY LENGTH LIMIT/i.test(t)) throw new Error('no translation');
  const seen = new Set([t.toLowerCase()]);
  const others = [];
  for (const m of j.matches || []) {
    const v = (m.translation || '').trim();
    if (v && !seen.has(v.toLowerCase()) && others.length < 4) {
      seen.add(v.toLowerCase());
      others.push(v);
    }
  }
  return { translation: t, alts: others.length ? [{ pos: 'other', terms: others }] : [], src: sl, translit: '', provider: 'MyMemory' };
}

// One dictionary entry -> { phonetic, defs: [{ pos, definition, example }], source }, at most three senses.
// Wiktionary (Wikimedia's own service) is asked first; the Free Dictionary API is the fallback.
const plain = html => String(html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
async function wiktionary(word, base) {
  const j = await fetchJson((base || 'https://en.wiktionary.org/api/rest_v1/page/definition/') + encodeURIComponent(word.replace(/ /g, '_')), 9000,
    { 'Api-User-Agent': 'Margin browser extension (github.com/thinhnguyen140107/margin-extension)' });
  const defs = [];
  for (const e of (j && j.en) || []) {
    const d = (e.definitions || []).find(x => plain(x.definition));
    if (!d || defs.length >= 3) continue;
    const ex = plain((d.parsedExamples && d.parsedExamples[0] && d.parsedExamples[0].example) || (d.examples || [])[0]);
    defs.push({ pos: String(e.partOfSpeech || '').toLowerCase(), definition: plain(d.definition), example: ex.length <= 180 ? ex : '' });
  }
  if (!defs.length) throw new Error('no entry');
  return { phonetic: '', defs, source: 'Wiktionary' };
}
async function freeDictionary(word) {
  const j = await fetchJson('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word), 3000);
  const entry = Array.isArray(j) ? j[0] : null;
  if (!entry) throw new Error('no entry');
  const phonetic = entry.phonetic || ((entry.phonetics || []).find(p => p.text) || {}).text || '';
  const defs = [];
  for (const m of entry.meanings || []) {
    const d = (m.definitions || [])[0];
    if (d && defs.length < 3) defs.push({ pos: m.partOfSpeech || '', definition: d.definition || '', example: d.example || '' });
  }
  if (!defs.length) throw new Error('no entry');
  return { phonetic, defs, source: 'Free Dictionary' };
}
let dictBase = ''; // a testing switch (settings.debugDict), only settable from an extension page
async function entryFor(word) {
  try { return await wiktionary(word, dictBase); } catch (e) { /* not there, or the service is busy */ }
  if (dictBase) throw new Error('no entry');
  return freeDictionary(word);
}
// For a word form ("hagiographies", "skimmed") the dictionary only says "plural of hagiography". That teaches
// nothing, so the base word is looked up too and its meaning is what gets shown (with a note of the form).
const FORM_OF = /^(?:(?:simple |present |past )?(?:plural|past|participle|tense|form|singular|third-person singular simple present indicative|comparative|superlative)[a-z ,-]*?) of ([a-z][a-z'-]*)\b/i;
async function dictionary(word) {
  const first = await entryFor(word);
  const m = first.defs.length && FORM_OF.exec(first.defs[0].definition);
  if (!m || m[1].toLowerCase() === word) return first;
  try {
    const base = await entryFor(m[1].toLowerCase());
    if (!base.defs.length) return first;
    return { phonetic: first.phonetic || base.phonetic, defs: base.defs, source: base.source, of: m[1].toLowerCase(), form: first.defs[0].definition.replace(/\.$/, '') };
  } catch (e) { return first; }
}

// Recent answers are kept in memory: looking the same word up again is instant.
const lookupCache = new Map();
function cached(key, make) {
  if (lookupCache.has(key)) return Promise.resolve(lookupCache.get(key));
  return make().then(value => {
    if (value && value.ok !== false) {
      lookupCache.set(key, value);
      if (lookupCache.size > 400) lookupCache.delete(lookupCache.keys().next().value);
    }
    return value;
  });
}

// The translation only. English definitions come separately (see define) so a slow dictionary
// server never holds the translation back.
async function lookup(text) {
  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!text) return { ok: false, error: 'Nothing selected' };
  const settings = await Store.getSettings();
  return cached('t|' + settings.targetLang + '|' + text.toLowerCase(), async () => {
    let tr = null;
    try {
      tr = await googleTranslate(text, settings.targetLang);
    } catch (e) {
      try { tr = await myMemoryTranslate(text, settings.sourceLang, settings.targetLang); } catch (e2) { tr = null; }
    }
    if (!tr) return { ok: false, error: 'Lookup failed. Check your internet connection and try again.' };
    return { ok: true, text, translation: tr.translation, alts: tr.alts, src: tr.src || settings.sourceLang, provider: tr.provider, phonetic: tr.translit || '', defs: [] };
  });
}
async function define(text) {
  const typed = String(text || '').replace(/\s+/g, ' ').trim();
  text = typed.toLowerCase();
  const settings = await Store.getSettings();
  if (!text || settings.sourceLang !== 'en' || text.split(' ').length > 3 || text.length > 48) return { ok: false };
  dictBase = typeof settings.debugDict === 'string' ? settings.debugDict : '';
  return cached('d|' + text, async () => {
    try { return Object.assign({ ok: true }, await dictionary(text)); } catch (e) { /* try it as written: names keep their capital */ }
    if (typed !== text) { try { return Object.assign({ ok: true }, await dictionary(typed)); } catch (e) { /* no entry */ } }
    return { ok: false };
  });
}

// ---------------------------------------------------------------- citation lookup (Crossref)
async function crossref(q) {
  try {
    if (q.doi) {
      const j = await fetchJson('https://api.crossref.org/works/' + q.doi.split('/').map(encodeURIComponent).join('/'), 12000);
      return { ok: true, items: j && j.message ? [j.message] : [] };
    }
    const j = await fetchJson('https://api.crossref.org/works?rows=6&query.bibliographic=' + encodeURIComponent(String(q.query || '').slice(0, 300)), 12000);
    return { ok: true, items: (j && j.message && j.message.items) || [] };
  } catch (e) {
    return { ok: false, items: [], error: String(e && e.message || e) };
  }
}

// ---------------------------------------------------------------- PDF routing
// content/pdf.js detects a PDF tab and asks whether to mount the reader inside it (the address bar keeps
// the PDF's own URL). "Browser viewer" sets a short-lived skip so the same URL opens natively once.
let skip = { url: '', until: 0 };
const stripHash = u => String(u || '').split('#')[0];

async function shouldEmbed(url) {
  if (skip.url === stripHash(url) && Date.now() < skip.until) return false;
  return (await Store.getSettings()).autoOpenPdf;
}

async function openPdf(url) {
  const embed = (await Store.getSettings()).autoOpenPdf;
  chrome.tabs.create({ url: embed ? url : readerUrl(url) });
}

/* dev-only:start */
// ---------------------------------------------------------------- self-update (folder install only)
// The store build has none of this: there the browser updates the extension itself.
// The extension is loaded unpacked, so new files can simply be written into its folder. Once a minute we
// compare the manifest on disk with the running one and reload when the version differs. Whoever updates
// the folder must bump "version" and write manifest.json LAST, so a half-copied update is never loaded.
async function openViews() {
  try { return await chrome.runtime.getContexts({ contextTypes: ['TAB'] }); } catch (e) { return []; }
}
async function applyUpdate() {
  const ids = [...new Set((await openViews()).map(c => c.tabId).filter(id => id >= 0))];
  await chrome.storage.local.set({ _reopen: ids });
  chrome.runtime.reload();
}
async function checkForUpdate() {
  try {
    const res = await fetch(chrome.runtime.getURL('manifest.json') + '?t=' + Date.now(), { cache: 'no-store' });
    const disk = (await res.json()).version;
    if (!disk || disk === chrome.runtime.getManifest().version) return;
    // Nothing of ours on screen: update silently. Otherwise offer it, so a note in progress is not interrupted.
    if (!(await openViews()).length) return applyUpdate();
    await chrome.storage.session.set({ updateReady: disk });
  } catch (e) { /* manifest mid-write; try again next minute */ }
}
async function afterUpdate() {
  const { _reopen } = await chrome.storage.local.get('_reopen');
  if (!_reopen) return;
  await chrome.storage.local.remove('_reopen');
  for (const id of _reopen) chrome.tabs.reload(id).catch(() => {}); // PDF tabs get their reader back
}
/* dev-only:end */

// ---------------------------------------------------------------- automatic backup
// Everything lives in this browser profile only, so a copy is written to Downloads/Margin backups on a
// schedule. One file per weekday, overwritten each week: a week of history in at most seven small files.
const BACKUP_DIR = 'Margin backups';
const BACKUP_EVERY = { daily: 12 * 3600000, often: 2 * 3600000 };

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function runBackup(force) {
  if (!chrome.downloads) return { ok: false, reason: 'The browser has not granted download access yet - reload Margin on the extensions page.' };
  const settings = await Store.getSettings();
  const mode = settings.backup || 'daily';
  if (!force && mode === 'off') return { ok: false, reason: 'off' };
  const payload = await Store.exportAll();
  const keys = Object.keys(payload.data);
  // Never replace a good backup with an empty one (e.g. right after the extension was re-added).
  if (!keys.some(k => /^(hl|voc|note|doc):/.test(k))) return { ok: false, reason: 'empty' };
  const body = JSON.stringify(payload.data);
  const fp = Store.hash(body) + ':' + body.length;
  const state = (await chrome.storage.local.get('_backup'))._backup || {};
  if (!force && (state.fp === fp || Date.now() - (state.at || 0) < (BACKUP_EVERY[mode] || BACKUP_EVERY.daily))) return { ok: false, reason: 'not due' };
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
  const filename = BACKUP_DIR + '/margin-backup-' + day + '.json';
  try {
    const id = await chrome.downloads.download({
      url: 'data:application/json;base64,' + toBase64(JSON.stringify(payload)), filename, conflictAction: 'overwrite', saveAs: false
    });
    await chrome.storage.local.set({ _backup: { at: Date.now(), fp, file: filename, id } });
    return { ok: true, file: filename };
  } catch (e) {
    await chrome.storage.local.set({ _backup: Object.assign({}, state, { error: String(e && e.message || e), errorAt: Date.now() }) });
    return { ok: false, reason: String(e && e.message || e) };
  }
}
// Keep the browser's download list tidy: drop our entry once the file is safely written (the file stays).
if (chrome.downloads) {
  chrome.downloads.onChanged.addListener(async delta => {
    if (!delta.state || delta.state.current !== 'complete') return;
    const state = (await chrome.storage.local.get('_backup'))._backup;
    if (state && state.id === delta.id) chrome.downloads.erase({ id: delta.id }).catch(() => {});
  });
}

// ---------------------------------------------------------------- badge
async function refreshBadge() {
  try {
    const due = (await Store.dueVocab()).length;
    await chrome.action.setBadgeBackgroundColor({ color: '#2f6f5e' });
    await chrome.action.setBadgeText({ text: due ? String(Math.min(due, 999)) : '' });
  } catch (e) { /* ignore */ }
}
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'badge') refreshBadge();
  /* dev-only:start */
  else if (a.name === 'update') checkForUpdate();
  /* dev-only:end */
  else if (a.name === 'backup') runBackup(false);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some(k => k.startsWith('voc:'))) refreshBadge();
});

// ---------------------------------------------------------------- menus + lifecycle
// The two selection items exist only while highlighting on web pages is switched on (it is off by default).
async function buildMenus() {
  const web = (await Store.getSettings()).webHighlights;
  chrome.contextMenus.removeAll(() => {
    if (web) {
      chrome.contextMenus.create({
        id: 'margin-translate', title: 'Translate "%s" with Margin', contexts: ['selection'],
        documentUrlPatterns: ['http://*/*', 'https://*/*', 'file:///*']
      });
      chrome.contextMenus.create({
        id: 'margin-highlight', title: 'Highlight selection', contexts: ['selection'],
        documentUrlPatterns: ['http://*/*', 'https://*/*', 'file:///*']
      });
    }
    chrome.contextMenus.create({ id: 'margin-open-link', title: 'Open link in Margin PDF reader', contexts: ['link'] });
  });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const was = changes.settings.oldValue || {}, now = changes.settings.newValue || {};
  if (!!was.webHighlights !== !!now.webHighlights) buildMenus();
});
function setup() {
  buildMenus();
  chrome.alarms.create('badge', { periodInMinutes: 15 });
  /* dev-only:start */
  chrome.alarms.create('update', { periodInMinutes: 1 });
  /* dev-only:end */
  chrome.alarms.create('backup', { periodInMinutes: 30, delayInMinutes: 2 });
  /* dev-only:start */
  afterUpdate();
  /* dev-only:end */
  refreshBadge();
}
chrome.runtime.onInstalled.addListener(details => {
  setup();
  // First install: open the dashboard, whose empty library shows a short getting-started guide.
  if (details.reason === 'install') chrome.tabs.create({ url: DASHBOARD });
});
chrome.runtime.onStartup.addListener(setup);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'margin-open-link') {
    const link = Store.safeUrl(info.linkUrl);
    if (link) chrome.tabs.create({ url: readerUrl(link) });
  } else if (tab && tab.id >= 0) {
    const type = info.menuItemId === 'margin-translate' ? 'ctx-translate' : 'ctx-highlight';
    chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'lookup') {
    lookup(msg.text).then(sendResponse, e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'define') {
    define(msg.text).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'crossref') {
    crossref(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'backup-now') {
    runBackup(true).then(sendResponse);
    return true;
  }
  if (msg.type === 'pdf-detected') {
    shouldEmbed(msg.url).then(embed => sendResponse({ embed, reader: READER }), () => sendResponse({ embed: false }));
    return true;
  }
  if (msg.type === 'embed-check') {
    // The reader only runs inside a frame when that frame sits on the very PDF it is asked to show.
    sendResponse(!!sender.tab && stripHash(sender.tab.url) === stripHash(msg.url));
    return;
  }
  // Addresses arriving in messages are only ever web or local-file addresses.
  const target = Store.safeUrl(msg.url);
  if (msg.type === 'pdf-redirect') {
    if (sender.tab && target) chrome.tabs.update(sender.tab.id, { url: readerUrl(target) });
  } else if (msg.type === 'open-pdf') {
    if (target) openPdf(target);
  } else if (msg.type === 'open-reader') {
    chrome.tabs.create({ url: target ? readerUrl(target) : READER });
  } else if (msg.type === 'open-dashboard') {
    chrome.tabs.create({ url: DASHBOARD + (/^[a-z]+$/.test(msg.hash || '') ? '#' + msg.hash : '') });
  } else if (msg.type === 'open-native') {
    if (!target) return;
    skip = { url: stripHash(target), until: Date.now() + 15000 };
    if (sender.tab) chrome.tabs.update(sender.tab.id, { url: target });
    else chrome.tabs.create({ url: target });
  /* dev-only:start */
  } else if (msg.type === 'apply-update') {
    applyUpdate();
  } else if (msg.type === 'check-update') {
    checkForUpdate();
  /* dev-only:end */
  } else if (msg.type === 'refresh-badge') {
    refreshBadge();
  }
});
