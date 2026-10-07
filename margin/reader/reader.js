// Margin Reader - PDF viewer (PDF.js) with highlights, notes and on-demand translation.
// Runs either as a standalone extension page or inside a frame mounted on the PDF's own tab.
import './pdfjs/pdf.mjs';
import * as Cite from './cite.js';

const pdfjsLib = globalThis.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('reader/pdfjs/pdf.worker.mjs');
const { EventBus, PDFViewer, PDFLinkService, PDFFindController } = await import('./pdfjs/pdf_viewer.mjs');

const Store = globalThis.MarginStore, UI = globalThis.MarginUI, h = UI.h;
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const fileParam = Store.safeUrl(params.get('file')); // web and local-file addresses only
const embedded = window.parent !== window;

if (embedded) {
  // Refuse to run in a frame unless that frame sits on the very PDF we were asked to show.
  const ok = fileParam && await chrome.runtime.sendMessage({ type: 'embed-check', url: fileParam }).catch(() => false);
  if (!ok) {
    document.body.textContent = '';
    throw new Error('Margin reader: blocked in this frame');
  }
  window.parent.postMessage({ margin: true, type: 'ready' }, '*');
}

const container = $('viewerContainer');
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });
const findController = new PDFFindController({ eventBus, linkService });
const viewer = new PDFViewer({
  container, viewer: $('viewer'), eventBus, linkService, findController,
  imageResourcesPath: chrome.runtime.getURL('reader/pdfjs/images/')
});
linkService.setViewer(viewer);
// Links inside a PDF open in a new tab, and the site they lead to learns nothing about this one.
linkService.externalLinkTarget = 2; // LinkTarget.BLANK
linkService.externalLinkRel = 'noopener noreferrer nofollow';

let settings = await Store.getSettings();
let pdf = null;
let doc = null;            // { id, type: 'pdf', title, url }
let highlights = [];
let sourceUrl = '';
let docRecord = null;      // saved library entry; holds this document's own colors
let titleSource = 'file';  // where the shown title came from: custom | meta | page | file
let pdfInfo = {};
let pageLabels = null;

// The four main colors plus any that belong to this document only.
const palette = () => Store.paletteFor(settings, docRecord, highlights);
const colorOf = id => Store.colorOf(palette(), id);
const hexOf = id => colorOf(id).hex;
const defaultColor = () => (palette().some(c => c.id === settings.defaultColor) ? settings.defaultColor : palette()[0].id);
async function addDocColor(info) {
  const c = await Store.saveDocColor(doc, info);
  docRecord = await Store.getDoc(doc.id);
  return c;
}

// ------------------------------------------------------------------ titles
function cleanFileName(name) {
  return String(name || '').replace(/\.pdf$/i, '').replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Document';
}
function nameFromUrl(u) {
  try {
    const p = decodeURIComponent(new URL(u).pathname.split('/').pop() || '');
    return p || new URL(u).hostname;
  } catch (e) { return 'Document'; }
}
// Publishers often leave a file name, an ISBN or "Microsoft Word - ..." in the title field.
// Headings that name a part of a book rather than the work itself.
const GENERIC_TITLE = /^(table of contents|contents|title page|cover|front ?matter|copyright|index|introduction|preface|foreword|acknowledge?ments|abstract|bibliography|references|notes|chapter \w+|part \w+|book \w+|page \d+)\.?$/i;
function usableTitle(t) {
  t = String(t || '').replace(/\s+/g, ' ').trim();
  if (t.length < 4 || t.length > 300) return '';
  if (/\.(pdf|docx?|indd|qxd|tex|dvi|rtf|pptx?|ps)$/i.test(t)) return '';
  if (/^(untitled|document\d*|microsoft word|slide \d|powerpoint)/i.test(t)) return '';
  if (GENERIC_TITLE.test(t)) return '';
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (letters / t.length < 0.5 || !/\p{L}{3}/u.test(t)) return '';
  return t;
}
const SMALL = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'in', 'on', 'for', 'to', 'is', 'as', 'at', 'by', 'from', 'with']);
function tidyTitle(t) {
  t = t.replace(/\s+/g, ' ').replace(/\s+([,.:;?!])/g, '$1').trim();
  if (/\p{Ll}/u.test(t)) return t;
  // ALL CAPS headline -> Title Case
  return t.toLocaleLowerCase().split(' ').map((w, i, all) => (i && SMALL.has(w) && !/[:?.!]$/.test(all[i - 1]) ? w : w.replace(/\p{L}/u, c => c.toLocaleUpperCase()))).join(' ');
}

// Reads the headline off the first pages: the block of text set in the largest type.
async function guessTitle() {
  for (let p = 1; p <= Math.min(2, pdf.numPages); p++) {
    let items;
    try {
      const page = await pdf.getPage(p);
      items = (await page.getTextContent()).items;
    } catch (e) { return ''; }
    items = items.filter(i => i.str && i.str.trim()).map(i => ({
      s: i.str, x: i.transform[4], y: i.transform[5], w: i.width,
      size: Math.round(Math.hypot(i.transform[2], i.transform[3]) * 2) / 2 || Math.round(i.height) || 10
    }));
    if (items.length < 2) continue;

    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const line = lines.find(l => Math.abs(l.y - it.y) < 0.4 * Math.max(it.size, 6));
      if (line) line.parts.push(it); else lines.push({ y: it.y, parts: [it] });
    }
    for (const l of lines) {
      l.parts.sort((a, b) => a.x - b.x);
      const weight = new Map();
      let text = '', prev = null;
      for (const part of l.parts) {
        weight.set(part.size, (weight.get(part.size) || 0) + part.s.trim().length);
        if (prev && part.x - (prev.x + prev.w) > prev.size * 0.18 && !/\s$/.test(text) && !/^\s/.test(part.s)) text += ' ';
        text += part.s;
        prev = part;
      }
      l.text = text.replace(/\s+/g, ' ').trim();
      l.size = [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0]; // size of most of the line (ignores drop caps)
    }

    const sizes = [...new Set(lines.map(l => l.size))].sort((a, b) => b - a).slice(0, 4);
    for (const size of sizes) {
      const run = [];
      for (const l of lines) {
        if (l.size < size * 0.92 || l.size > size * 1.08) { if (run.length) break; else continue; }
        if (run.length && run[run.length - 1].y - l.y > size * 2.8) break;
        run.push(l);
      }
      const text = run.map(l => l.text).join(' ').replace(/\s+/g, ' ').trim();
      const words = text.split(' ');
      const letters = (text.match(/\p{L}/gu) || []).length;
      if (text.length >= 8 && text.length <= 220 && words.length >= 2 && letters / text.length > 0.6 && letters / words.length >= 3 && !GENERIC_TITLE.test(text)) {
        return tidyTitle(text);
      }
    }
  }
  return '';
}

function setTitle(title) {
  doc.title = title;
  $('title').textContent = title;
  $('title').title = title + '\n' + (sourceUrl || doc.fileName || '') + '\nClick to rename';
  document.title = title;
  if (embedded) window.parent.postMessage({ margin: true, type: 'title', title }, '*');
}

function renameTitle() {
  if (!doc || document.querySelector('.titleInput')) return;
  const label = $('title');
  const input = h('input', { class: 'titleInput', 'aria-label': 'Document title' });
  input.value = doc.title;
  label.hidden = true;
  label.after(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async save => {
    if (done) return;
    done = true;
    const value = input.value.replace(/\s+/g, ' ').trim();
    input.remove();
    label.hidden = false;
    if (save && value && value !== doc.title) {
      setTitle(value);
      await Store.upsertDoc({ id: doc.id, type: 'pdf', title: value, url: sourceUrl, fileName: doc.fileName, titleCustom: true });
    }
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
}
$('title').addEventListener('click', renameTitle);
$('title').addEventListener('keydown', e => { if (e.key === 'Enter') renameTitle(); });

// ------------------------------------------------------------------ loading
function showError(msg) {
  $('empty').hidden = false;
  $('error').hidden = false;
  $('error').textContent = msg;
  renderRecent();
}

function askPassword(wrong) {
  return new Promise(resolve => {
    const dlg = $('pwDialog');
    $('pwText').textContent = wrong ? 'Incorrect password. Try again.' : 'This PDF is password-protected.';
    $('pwInput').value = '';
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? $('pwInput').value : null), { once: true });
    dlg.showModal();
    $('pwInput').focus();
  });
}

async function openDocument(src, fileName) {
  UI.hide();
  $('error').hidden = true;
  $('title').textContent = 'Loading...';
  try {
    if (pdf) { await pdf.loadingTask.destroy(); pdf = null; }
    const task = pdfjsLib.getDocument(Object.assign({
      cMapUrl: chrome.runtime.getURL('reader/pdfjs/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: chrome.runtime.getURL('reader/pdfjs/standard_fonts/'),
      withCredentials: !!src.url && /^https?:/i.test(src.url)
    }, src));
    task.onPassword = async (update, reason) => {
      const pw = await askPassword(reason === 2);
      if (pw === null) task.destroy(); else update(pw);
    };
    pdf = await task.promise;
  } catch (e) {
    $('title').textContent = '';
    showError('Could not open this PDF' + (src.url ? ' (' + src.url + ')' : '') + '. ' + (e && e.message ? e.message : ''));
    return;
  }

  sourceUrl = src.url || '';
  const id = 'pdf-' + pdf.fingerprints[0];
  const saved = await Store.getDoc(id);
  doc = { id, type: 'pdf', title: cleanFileName(fileName), url: sourceUrl, fileName };
  highlights = await Store.getHighlights(id);
  docRecord = saved || null;
  cite = null;
  resetOcr();
  pdfInfo = {};
  pageLabels = null;
  try { pdfInfo = (await pdf.getMetadata()).info || {}; } catch (e) { /* no metadata */ }
  try { pageLabels = await pdf.getPageLabels(); } catch (e) { /* none */ }

  // Title: the name you gave it > embedded metadata > headline on the first page > tidied file name.
  let title = saved && saved.titleCustom ? saved.title : '';
  titleSource = title ? 'custom' : 'file';
  if (!title && (title = usableTitle(pdfInfo.Title))) titleSource = 'meta';
  if (!title && (title = await guessTitle())) titleSource = 'page';
  setTitle(title || doc.title);
  if (saved && saved.title !== doc.title) Store.patchDoc(id, { title: doc.title });

  $('pageCount').textContent = pdf.numPages;
  $('docTools').hidden = false;
  $('docActions').hidden = false;
  $('edge').hidden = false;
  $('empty').hidden = true;

  viewer.setDocument(pdf);
  linkService.setDocument(pdf);
  renderSidebar();
  renderOutline();
  if (!$('thumbs').hidden) renderThumbs();
  setDrawing(false);
  draw.made = [];
  hintIfScanned();
  loadCite();
}

async function openFile(file) {
  if (!file) return;
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { showError('That file is not a PDF.'); return; }
  const data = new Uint8Array(await file.arrayBuffer());
  await openDocument({ data }, file.name);
}

eventBus.on('pagesinit', async () => {
  viewer.currentScaleValue = settings.readerScale || 'auto';
  const saved = doc && (await Store.getDoc(doc.id));
  const here = doc && ((await chrome.storage.local.get('_pos'))._pos || {})[doc.id];
  // the newer of: this computer's own record, and the one that travels with the document (sync)
  let last = saved && saved.lastPage ? { page: saved.lastPage, frac: saved.lastPos, at: saved.posAt || 0 } : null;
  if (here && (!last || here.at >= last.at)) last = here;
  resume = null;
  if (last && last.page >= 1 && last.page <= pdf.numPages) {
    const frac = Math.min(0.98, Math.max(0, Number(last.frac) || 0));
    if (last.page > 1 || frac > 0.02) resume = { page: last.page, frac };
  }
  if (resume) {
    goToPlace(resume);
    if (resume.page > 1) UI.toast('Back where you stopped: page ' + (printedPage(resume.page) || resume.page));
  }
  container.focus();
});
// Pages can change size once the whole file is known; land on the same spot again unless the reader has moved on.
eventBus.on('pagesloaded', () => { if (resume && !resume.moved) goToPlace(resume); resume = null; });

// ------------------------------------------------------------------ reading position
// Where you stopped: the page at the top of the window and how far down that page (0..1), kept with the document.
let resume = null, placeTimer = null, placeQuiet = 0;
function currentPlace() {
  if (!pdf) return null;
  const top = container.scrollTop + 1;
  let page = viewer.currentPageNumber || 1, pv = viewer.getPageView(page - 1);
  // the page that actually holds the top edge of the window
  while (pv && page > 1 && pv.div.offsetTop > top) pv = viewer.getPageView(--page - 1);
  while (pv && page < pdf.numPages && pv.div.offsetTop + pv.div.offsetHeight <= top) pv = viewer.getPageView(++page - 1);
  if (!pv) return null;
  return { page, frac: Math.min(0.98, Math.max(0, (top - pv.div.offsetTop) / Math.max(1, pv.div.offsetHeight))) };
}
function goToPlace(place) {
  const pv = viewer.getPageView(place.page - 1);
  if (!pv) return;
  placeQuiet = Date.now() + 400;
  container.scrollTop = Math.max(0, Math.round(pv.div.offsetTop + place.frac * pv.div.offsetHeight));
}
function savePlace() {
  clearTimeout(placeTimer);
  const place = doc && currentPlace();
  if (!place) return;
  if (savePlace.last && savePlace.last.page === place.page && Math.abs(savePlace.last.frac - place.frac) < 0.005) return;
  savePlace.last = place;
  const at = Date.now(), frac = Math.round(place.frac * 1000) / 1000, id = doc.id;
  // Every PDF is remembered on this computer (the 400 most recent); one that is in the library also carries its place with it.
  chrome.storage.local.get('_pos').then(got => {
    const all = got._pos || {};
    all[id] = { page: place.page, frac, at };
    const ids = Object.keys(all);
    if (ids.length > 400) ids.sort((x, y) => all[x].at - all[y].at).slice(0, ids.length - 400).forEach(x => delete all[x]);
    return chrome.storage.local.set({ _pos: all });
  }).catch(() => {});
  Store.patchDoc(id, { lastPage: place.page, lastPos: frac, posAt: at });
}
container.addEventListener('scroll', () => {
  if (Date.now() < placeQuiet) return; // our own positioning, not the reader's
  if (resume) resume.moved = true;
  clearTimeout(placeTimer);
  placeTimer = setTimeout(savePlace, 1200);
}, { passive: true });
window.addEventListener('pagehide', savePlace);
document.addEventListener('visibilitychange', () => { if (document.hidden) savePlace(); });

let scaleSaveTimer = null;
eventBus.on('pagechanging', e => {
  $('pageNum').value = e.pageNumber;
  for (const p of [e.pageNumber, e.pageNumber + 1]) if (p <= pdf.numPages) maybeRecognize(p);
  markThumb(false);
});
eventBus.on('scalechanging', e => {
  if (!zooming) resetPad(); // "fit width", 100% and the like put the pages back where the browser lays them out
  $('zoomPct').textContent = Math.round(e.scale * 100) + '%';
  $('fit').setAttribute('aria-pressed', String(e.presetValue === 'page-width'));
  clearTimeout(scaleSaveTimer);
  scaleSaveTimer = setTimeout(() => Store.setSettings({ readerScale: e.presetValue || String(e.scale) }), 600);
});
eventBus.on('pagerendered', e => { drawPage(e.pageNumber); maybeRecognize(e.pageNumber); paintSelection(); });
eventBus.on('rotationchanging', () => { resetPad(); widest = null; });
eventBus.on('pagesinit', () => { resetPad(); widest = null; });
eventBus.on('rotationchanging', () => document.querySelectorAll('.mg-ocr').forEach(el => { el.dataset.mainRotation = viewer.pagesRotation; }));

// ------------------------------------------------------------------ highlight overlay
// Rectangles are stored as fractions of the unrotated page; these convert to and from what is on screen.
function toBase(r, rot) {
  if (rot === 90) return { x: r.y, y: 1 - (r.x + r.w), w: r.h, h: r.w };
  if (rot === 180) return { x: 1 - (r.x + r.w), y: 1 - (r.y + r.h), w: r.w, h: r.h };
  if (rot === 270) return { x: 1 - (r.y + r.h), y: r.x, w: r.h, h: r.w };
  return { x: r.x, y: r.y, w: r.w, h: r.h };
}
function toShown(r) {
  const rot = viewer.pagesRotation;
  if (rot === 90) return { x: 1 - (r.y + r.h), y: r.x, w: r.h, h: r.w };
  if (rot === 180) return { x: 1 - (r.x + r.w), y: 1 - (r.y + r.h), w: r.w, h: r.h };
  if (rot === 270) return { x: r.y, y: 1 - (r.x + r.w), w: r.h, h: r.w };
  return r;
}

// Highlights saved by version 1.0 were measured against a page box that was 18px too small (since fixed).
// They carry no version tag; rescale them assuming the default zoom they were most likely made at.
function baseRect(hl, r) {
  if (hl.v) return r;
  const pv = viewer.getPageView(r.page - 1);
  if (!pv || !pv.div || !pv.scale) return r;
  const sideways = viewer.pagesRotation === 90 || viewer.pagesRotation === 270;
  const w0 = (sideways ? pv.div.clientHeight : pv.div.clientWidth) / pv.scale * 1.25;
  const h0 = (sideways ? pv.div.clientWidth : pv.div.clientHeight) / pv.scale * 1.25;
  const kx = (w0 - 18) / w0, ky = (h0 - 18) / h0;
  return { page: r.page, x: r.x * kx, y: r.y * ky, w: r.w * kx, h: r.h * ky };
}

// When a page is redrawn (after zooming, for instance) the viewer empties it, highlights included. They are put
// straight back, before the screen is painted, so they do not blink.
const layerGuard = new MutationObserver(records => {
  const hit = new Set();
  for (const r of records) for (const n of r.removedNodes) if (n.classList && n.classList.contains('mg-layer')) hit.add(r.target);
  for (const div of hit) {
    const p = Number(div.dataset.pageNumber);
    if (p && pdf && div.isConnected && !div.querySelector(':scope > .mg-layer')) drawPage(p);
  }
  if (hit.size) paintSelection();
});
function layerFor(pageNumber, create) {
  const pv = viewer.getPageView(pageNumber - 1);
  if (!pv || !pv.div) return null;
  let layer = pv.div.querySelector(':scope > .mg-layer');
  if (!layer && create) {
    layer = h('div', { class: 'mg-layer' });
    pv.div.appendChild(layer);
    layerGuard.observe(pv.div, { childList: true });
  }
  return layer;
}

function drawPage(pageNumber) {
  const layer = layerFor(pageNumber, true);
  if (!layer) return;
  layer.textContent = '';
  for (const hl of highlights) {
    for (const base of hl.rects || []) {
      if (base.page !== pageNumber) continue;
      const r = toShown(baseRect(hl, base));
      const el = h('div', { class: 'mg-rect' + (hl.kind === 'vocab' ? ' vocab' : '') + (hl.note ? ' noted' : '') });
      el.dataset.id = hl.id;
      el.style.cssText = 'left:' + r.x * 100 + '%;top:' + r.y * 100 + '%;width:' + r.w * 100 + '%;height:' + r.h * 100 + '%;background:' + hexOf(hl.color);
      layer.appendChild(el);
    }
  }
  const inks = highlights.filter(hl => hl.kind === 'ink' && hl.page === pageNumber && (hl.points || []).length);
  if (inks.length) {
    const svg = inkSvg(layer, pageNumber);
    for (const hl of inks) svg.appendChild(inkPath(hl, svg));
  }
}
function drawAll() {
  if (!pdf) return;
  for (let p = 1; p <= pdf.numPages; p++) if (layerFor(p, false)) drawPage(p);
}

function textNodesIn(range) {
  const root = range.commonAncestorContainer;
  if (root.nodeType === 3) return [root];
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) if (range.intersectsNode(n)) out.push(n);
  return out;
}

// Selection -> one rectangle per line, per page.
function rectsFromRange(range) {
  const raw = new Map(); // pageNumber -> { ref, list: [{x,y,w,h} px relative to the page] }
  for (const n of textNodesIn(range)) {
    const parent = n.parentElement;
    if (!parent || !parent.closest('.textLayer') || parent.closest('.endOfContent')) continue;
    const s = n === range.startContainer ? range.startOffset : 0;
    const e = n === range.endContainer ? range.endOffset : n.data.length;
    if (e <= s || !n.data.slice(s, e).trim()) continue;
    const pageEl = parent.closest('.page');
    const pageNumber = Number(pageEl && pageEl.dataset.pageNumber);
    const layer = pageNumber && layerFor(pageNumber, true);
    if (!layer) continue;
    const ref = layer.getBoundingClientRect();
    const r = document.createRange();
    r.setStart(n, s);
    r.setEnd(n, e);
    for (const cr of r.getClientRects()) {
      if (cr.width < 1 || cr.height < 1) continue;
      if (!raw.has(pageNumber)) raw.set(pageNumber, { ref, list: [] });
      raw.get(pageNumber).list.push({ x: cr.left - ref.left, y: cr.top - ref.top, w: cr.width, h: cr.height });
    }
  }
  const rot = viewer.pagesRotation;
  const sideways = rot === 90 || rot === 270;
  const out = [];
  for (const [page, { ref, list }] of raw) {
    // "along" is the reading direction of a line, "across" is the line's thickness.
    const A = r => (sideways ? { a: r.y, al: r.h, c: r.x, cl: r.w } : { a: r.x, al: r.w, c: r.y, cl: r.h });
    const lines = [];
    for (const r of list.map(A).sort((p, q) => p.c - q.c || p.a - q.a)) {
      const line = lines.find(l => {
        const overlap = Math.min(l.c + l.cl, r.c + r.cl) - Math.max(l.c, r.c);
        const gap = Math.max(l.cl, r.cl) * 1.5;
        return overlap > 0.5 * Math.min(l.cl, r.cl) && r.a <= l.a + l.al + gap && r.a + r.al >= l.a - gap;
      });
      if (line) {
        const a2 = Math.max(line.a + line.al, r.a + r.al), c2 = Math.max(line.c + line.cl, r.c + r.cl);
        line.a = Math.min(line.a, r.a);
        line.c = Math.min(line.c, r.c);
        line.al = a2 - line.a;
        line.cl = c2 - line.c;
      } else lines.push(r);
    }
    for (const l of lines) {
      const px = sideways ? { x: l.c, y: l.a, w: l.cl, h: l.al } : { x: l.a, y: l.c, w: l.al, h: l.cl };
      const base = toBase({ x: px.x / ref.width, y: px.y / ref.height, w: px.w / ref.width, h: px.h / ref.height }, rot);
      base.page = page;
      out.push(base);
    }
  }
  return out;
}

// Sentence around the selection, rebuilt from the page's text layer.
function contextFor(range, text) {
  let el = range.startContainer;
  if (el.nodeType !== 1) el = el.parentElement;
  const layer = el && el.closest('.textLayer');
  if (!layer) return '';
  let full = '', start = -1, lastParent = null, lastNode = null;
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (lastNode && n.data.trim() && LINE_HYPHEN.test(full) && brokenWord(lastNode, n)) full = full.replace(/[-\u2010\u00AD]\s*$/, '');
    else if (lastParent && n.parentElement !== lastParent && !/\s$/.test(full) && !(lastNode && joinsWord(lastNode, n))) full += ' ';
    lastParent = n.parentElement;
    lastNode = n.data.trim() ? n : lastNode;
    if (n === range.startContainer) start = full.length + range.startOffset;
    full += n.data;
  }
  if (start < 0) return '';
  return UI.sentenceAround(full, start, Math.min(full.length, start + text.length));
}

async function createHighlight(range, text, props) {
  const rects = rectsFromRange(range);
  if (!rects.length) return null;
  const hl = await Store.addHighlight(doc, Object.assign({ v: 2, color: defaultColor(), text, page: rects[0].page, rects }, props));
  highlights = await Store.getHighlights(doc.id);
  drawAll();
  renderSidebar();
  return hl;
}

function sourceInfo(page) {
  return { docId: doc.id, docTitle: doc.title, url: sourceUrl, page };
}

function openEditor(hl, rect, opts) {
  UI.showEditor(rect, hl, {
    onColor: c => Store.updateHighlight(doc.id, hl.id, hl.kind === 'ink' ? { color: c } : { color: c, kind: 'highlight' }),
    onNote: note => Store.updateHighlight(doc.id, hl.id, { note }),
    onDelete: () => Store.removeHighlight(doc.id, hl.id),
    onTranslate: () => UI.showCard(rect, { text: hl.text, context: '', source: sourceInfo(hl.page) })
  }, Object.assign({ palette: palette() }, opts));
}

// ------------------------------------------------------------------ double-click = the whole word
// A PDF stores a line as separate pieces of text, and a word is often cut between two of them ("commentar" + "y").
// The browser stops a double-click selection at such a cut. Here the selection is grown across pieces that sit
// right against each other on the same line, until the real ends of the word.
const WORDCHAR = /[\p{L}\p{N}\p{M}]/u;
function textNeighbour(node, dir) {
  const layer = node.parentElement && node.parentElement.closest('.textLayer');
  if (!layer) return null;
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  walker.currentNode = node;
  let n;
  while ((n = dir < 0 ? walker.previousNode() : walker.nextNode())) {
    if (n.data.length && !(n.parentElement && n.parentElement.closest('.endOfContent'))) return n;
  }
  return null;
}
function edgeBox(node, atEnd) { // the box of a text node's first or last character
  const r = document.createRange();
  const i = atEnd ? node.data.length - 1 : 0;
  r.setStart(node, i);
  r.setEnd(node, i + 1);
  return r.getBoundingClientRect();
}
// Is `next` the direct continuation of `prev` on the same line (no room for a space between them)?
function touching(prev, next) {
  const a = edgeBox(prev, true), b = edgeBox(next, false);
  if (!a.height || !b.height) return false;
  const sideways = viewer.pagesRotation === 90 || viewer.pagesRotation === 270;
  const size = sideways ? Math.min(a.width, b.width) : Math.min(a.height, b.height);
  const overlap = sideways ? Math.min(a.right, b.right) - Math.max(a.left, b.left) : Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (overlap < 0.5 * size) return false;
  const gaps = sideways ? [b.top - a.bottom, a.top - b.bottom] : [b.left - a.right, a.left - b.right];
  const gap = Math.max(gaps[0], gaps[1]); // whichever way the text runs
  return gap < 0.16 * size && gap > -0.6 * size;
}
const joinsWord = (prev, next) => WORDCHAR.test(prev.data[prev.data.length - 1] || '') && WORDCHAR.test(next.data[0] || '') && touching(prev, next);
// The words of a selection, with the pieces of a cut word put back together (and a space between everything else).
// A word broken at the end of a line: "transmis-" closes one line and "sion" opens the next. Such a pair is one
// word (the hyphen belongs to the typesetting, not to the word). Only for upright pages.
const LINE_HYPHEN = /\p{L}[-\u2010\u00AD]\s*$/u;
function charBox(node, i) {
  const r = document.createRange();
  r.setStart(node, i);
  r.setEnd(node, i + 1);
  return r.getBoundingClientRect();
}
function brokenWord(prev, next) {
  if (viewer.pagesRotation || !LINE_HYPHEN.test(prev.data) || !/^\s*\p{Ll}/u.test(next.data)) return false;
  const a = charBox(prev, prev.data.search(/[-\u2010\u00AD]\s*$/)), b = charBox(next, next.data.search(/\S/));
  if (!a.height || !b.height) return false;
  return b.top > a.top + a.height * 0.5 && b.top < a.top + a.height * 3 && b.left < a.left; // the next line down, further left
}
// The next piece of text that is not just spaces.
function solidNeighbour(node, dir) {
  let n = node;
  for (let i = 0; i < 4 && (n = textNeighbour(n, dir)); i++) if (n.data.trim()) return n;
  return null;
}
function rangeText(range) {
  let out = '', last = null;
  for (const n of textNodesIn(range)) {
    const parent = n.parentElement;
    if (!parent || !parent.closest('.textLayer') || parent.closest('.endOfContent')) continue;
    const s = n === range.startContainer ? range.startOffset : 0;
    const e = n === range.endContainer ? range.endOffset : n.data.length;
    if (e <= s) continue;
    if (!n.data.trim() && last) continue; // spacing between pieces is worked out below
    if (last && s === 0 && LINE_HYPHEN.test(out) && brokenWord(last, n)) out = out.replace(/[-\u2010\u00AD]\s*$/, '');
    else if (last && !/\s$/.test(out) && !(last.parentElement === parent || joinsWord(last, n))) out += ' ';
    out += n.data.slice(s, e);
    last = n;
  }
  return out.replace(/\s+/g, ' ').trim();
}
// Grows a stretch of text to the ends of the word(s) it touches. -> [startNode, startOffset, endNode, endOffset]
function wordBounds(sn, so, en, eo) {
  for (let guard = 0; guard < 200; guard++) { // backwards
    if (so > 0) {
      if (!WORDCHAR.test(sn.data[so - 1])) break;
      so--;
    } else {
      const prev = textNeighbour(sn, -1);
      if (prev && joinsWord(prev, sn)) { sn = prev; so = prev.data.length; continue; }
      const above = solidNeighbour(sn, -1); // "sion" at the start of a line: carry on into "transmis-" above
      if (!above || !brokenWord(above, sn)) break;
      sn = above;
      so = above.data.search(/[-\u2010\u00AD]\s*$/);
    }
  }
  for (let guard = 0; guard < 200; guard++) { // forwards
    if (eo < en.data.length) {
      if (WORDCHAR.test(en.data[eo])) { eo++; continue; }
      // "transmis" right before a line-end hyphen: carry on into "sion" on the next line
      if (eo > 0 && /^[-\u2010\u00AD]\s*$/.test(en.data.slice(eo))) {
        const below = solidNeighbour(en, 1);
        if (below && brokenWord(en, below)) { en = below; eo = below.data.search(/\S/); continue; }
      }
      break;
    }
    const next = textNeighbour(en, 1);
    if (!next || !joinsWord(en, next)) break;
    en = next;
    eo = 0;
  }
  return [sn, so, en, eo];
}
// The letter under a point of the page: its text node and index, or null.
function letterAt(x, y, target) {
  const r = document.createRange();
  const holds = (node, i) => {
    if (i < 0 || i >= node.data.length) return false;
    r.setStart(node, i);
    r.setEnd(node, i + 1);
    const b = r.getBoundingClientRect();
    return x >= b.left - 1 && x <= b.right + 1 && y >= b.top - 2 && y <= b.bottom + 2;
  };
  const inLayer = node => node && node.nodeType === 3 && node.parentElement.closest('#viewer .textLayer') && !node.parentElement.closest('.endOfContent');
  // the caret sits between two letters; take the one whose box holds the point
  const caret = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
  if (caret && inLayer(caret.startContainer)) {
    for (const i of [caret.startOffset - 1, caret.startOffset]) if (holds(caret.startContainer, i)) return { node: caret.startContainer, index: i };
  }
  // otherwise look through the piece of text that was clicked
  if (target && target.closest('#viewer .textLayer')) {
    for (const node of target.childNodes) {
      if (!inLayer(node) || node.data.length > 2000) continue;
      for (let i = 0; i < node.data.length; i++) if (holds(node, i)) return { node, index: i };
    }
  }
  return null;
}
document.addEventListener('dblclick', e => {
  if (!pdf || draw.on || !e.target.closest || !e.target.closest('#viewer .textLayer')) return;
  const sel = getSelection();
  // Work from the letter that was actually clicked; what the browser selected on its own can be a fragment or nothing.
  const hit = letterAt(e.clientX, e.clientY, e.target);
  if (hit && WORDCHAR.test(hit.node.data[hit.index])) {
    sel.setBaseAndExtent(...wordBounds(hit.node, hit.index, hit.node, hit.index + 1));
    return;
  }
  if (!sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const sn = range.startContainer, en = range.endContainer;
  if (sn.nodeType !== 3 || en.nodeType !== 3 || !sn.parentElement.closest('#viewer .textLayer') || !en.parentElement.closest('#viewer .textLayer')) return;
  if (!WORDCHAR.test(sn.data[range.startOffset] || '') || !WORDCHAR.test(en.data[range.endOffset - 1] || '')) return; // not a word: leave it
  sel.setBaseAndExtent(...wordBounds(sn, range.startOffset, en, range.endOffset));
});

// ------------------------------------------------------------------ selection
// The browser paints a selection piece by piece, and where pieces of a line overlap the color doubles into stripes.
// Margin hides that and paints the selection itself: one even block per line.
let selPages = [], selFrame = 0;
function clearSelection() {
  for (const el of selPages) el.remove();
  selPages = [];
}
function paintSelection() {
  selFrame = 0;
  clearSelection();
  if (!pdf || draw.on) return;
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  let root = range.commonAncestorContainer;
  if (root.nodeType !== 1) root = root.parentElement;
  if (!root || !root.closest('#viewer')) return;
  const sideways = viewer.pagesRotation === 90 || viewer.pagesRotation === 270;
  const byPage = new Map();
  for (const base of rectsFromRange(range)) {
    if (!byPage.has(base.page)) byPage.set(base.page, []);
    byPage.get(base.page).push(toShown(base));
  }
  for (const [page, rects] of byPage) {
    const pv = viewer.getPageView(page - 1);
    if (!pv || !pv.div) continue;
    if (!sideways) {
      // neighbouring lines that touch: stop the upper one where the lower one begins, so the seam is not darker
      rects.sort((a, b) => a.y - b.y);
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const over = a.y + a.h - b.y;
        if (over <= 0) break;
        if (over < 0.5 * Math.min(a.h, b.h) && a.x < b.x + b.w && b.x < a.x + a.w) a.h = b.y - a.y;
      }
    }
    const box = h('div', { class: 'mg-sel' }, rects.map(r => {
      const el = h('div');
      el.style.cssText = 'left:' + r.x * 100 + '%;top:' + r.y * 100 + '%;width:' + r.w * 100 + '%;height:' + r.h * 100 + '%';
      return el;
    }));
    pv.div.appendChild(box);
    selPages.push(box);
  }
}
document.addEventListener('selectionchange', () => { if (!selFrame) selFrame = requestAnimationFrame(paintSelection); });

function currentSelection() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  let el = range.commonAncestorContainer;
  if (el.nodeType !== 1) el = el.parentElement;
  if (!el || !el.closest('#viewer')) return null;
  const text = rangeText(range);
  if (!text) return null;
  return { range: range.cloneRange(), text };
}

function rectOf(range) {
  const rects = Array.from(range.getClientRects()).filter(r => r.width > 1 && r.height > 1);
  if (!rects.length) return range.getBoundingClientRect();
  const top = Math.min(...rects.map(r => r.top)), bottom = Math.max(...rects.map(r => r.bottom));
  const left = Math.min(...rects.map(r => r.left)), right = Math.max(...rects.map(r => r.right));
  const t = Math.max(top, container.getBoundingClientRect().top);
  return { left, right, top: t, bottom: Math.max(t, bottom), width: right - left, height: Math.max(0, bottom - t) };
}

// What can be done with the current selection - the same actions for the toolbar and for the keyboard.
function selectionActions(cur, rect) {
  return {
    async onColor(color) {
      await createHighlight(cur.range, cur.text, { color });
      getSelection().removeAllRanges();
    },
    async onNote() {
      const hl = await createHighlight(cur.range, cur.text, {});
      getSelection().removeAllRanges();
      if (hl) openEditor(hl, rect, { focusNote: true });
    },
    onTranslate() {
      const page = Number((cur.range.startContainer.parentElement.closest('.page') || {}).dataset?.pageNumber) || null;
      UI.showCard(rect, { text: cur.text, context: contextFor(cur.range, cur.text), source: sourceInfo(page) }, {
        async onSaved() {
          if (!settings.markSavedWords || cur.text.length > 80) return;
          await createHighlight(cur.range, cur.text, { kind: 'vocab' });
          getSelection().removeAllRanges();
        }
      });
    },
    onAddColor: addDocColor
  };
}
document.addEventListener('mouseup', e => {
  if (UI.isOwn(e.target) || !pdf) return;
  setTimeout(() => {
    const cur = currentSelection();
    if (!cur) return;
    const rect = rectOf(cur.range);
    UI.showToolbar(rect, selectionActions(cur, rect), palette());
  }, 0);
});
// With text selected: 1-4 highlight in that color, T looks the word up, N adds a note.
document.addEventListener('keydown', e => {
  if (!pdf || draw.on || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (UI.isOwn(e.target) || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable || document.querySelector('dialog[open]')) return;
  const key = e.key.toLowerCase();
  const color = /^[1-4]$/.test(key) ? palette()[Number(key) - 1] : null;
  if (!color && key !== 't' && key !== 'n') return;
  const cur = currentSelection();
  if (!cur) return;
  e.preventDefault();
  const rect = rectOf(cur.range), act = selectionActions(cur, rect);
  UI.hideToolbar();
  if (color) act.onColor(color.id); else if (key === 't') act.onTranslate(); else act.onNote();
});
document.addEventListener('mousedown', e => { if (!UI.isOwn(e.target)) UI.hide(); }, true);
container.addEventListener('scroll', () => UI.hideToolbar(), { passive: true });

// Clicking an existing highlight opens its editor (the overlay itself never blocks text selection).
container.addEventListener('click', e => {
  if (draw.on || !getSelection().isCollapsed) return;
  const pageEl = e.target.closest && e.target.closest('.page');
  if (!pageEl || e.target.closest('a')) return;
  const page = Number(pageEl.dataset.pageNumber);
  const layer = layerFor(page, false);
  if (!layer) return;
  const ref = layer.getBoundingClientRect();
  const fx = (e.clientX - ref.left) / ref.width, fy = (e.clientY - ref.top) / ref.height;
  let hit = null, rs = null;
  for (const hl of highlights) {
    const shown = (hl.rects || []).filter(r => r.page === page).map(r => toShown(baseRect(hl, r)));
    if (shown.some(r => fx >= r.x && fx <= r.x + r.w && fy >= r.y && fy <= r.y + r.h)) { hit = hl; rs = shown; }
  }
  if (!hit) {
    const ink = inkAt(page, fx, fy, ref);
    if (ink) {
      const b = inkBounds(ink);
      openEditor(ink, {
        left: ref.left + b.x * ref.width, right: ref.left + (b.x + b.w) * ref.width, width: b.w * ref.width,
        top: ref.top + b.y * ref.height, bottom: ref.top + (b.y + b.h) * ref.height, height: b.h * ref.height
      });
    }
    return;
  }
  const top = Math.min(...rs.map(r => r.y)), bottom = Math.max(...rs.map(r => r.y + r.h));
  const left = Math.min(...rs.map(r => r.x)), right = Math.max(...rs.map(r => r.x + r.w));
  openEditor(hit, {
    left: ref.left + left * ref.width, right: ref.left + right * ref.width, width: (right - left) * ref.width,
    top: ref.top + top * ref.height, bottom: ref.top + bottom * ref.height, height: (bottom - top) * ref.height
  });
});

// ------------------------------------------------------------------ pen and highlighter
// For scanned pages with no selectable text: strokes are drawn by hand and stored like highlights
// (kind 'ink'), as points in fractions of the unrotated page.
const draw = {
  on: false,
  tool: settings.drawTool || 'marker',
  color: settings.drawColor || 'yellow', // id from the same palette the text highlighter uses
  size: { marker: settings.markerSize || 5, pen: settings.penSize || 3 },
  cur: null,
  made: []
};
const inkColor = hl => hexOf(hl.color);
const inkWidth = (tool, v) => (tool === 'pen' ? 0.0008 + v * 0.0006 : 0.006 + v * 0.0035); // fraction of page width
const isSideways = () => viewer.pagesRotation === 90 || viewer.pagesRotation === 270;

function pointToShown(p) {
  const rot = viewer.pagesRotation;
  if (rot === 90) return [1 - p[1], p[0]];
  if (rot === 180) return [1 - p[0], 1 - p[1]];
  if (rot === 270) return [p[1], 1 - p[0]];
  return p;
}
function pointToBase(p) {
  const rot = viewer.pagesRotation;
  if (rot === 90) return [p[1], 1 - p[0]];
  if (rot === 180) return [1 - p[0], 1 - p[1]];
  if (rot === 270) return [1 - p[1], p[0]];
  return p;
}

// One SVG per page, in a 1000-wide coordinate space with the page's aspect ratio, so it scales with zoom.
function inkSvg(layer, pageNumber) {
  let svg = layer.querySelector(':scope > .mg-svg');
  if (svg) return svg;
  const vp = viewer.getPageView(pageNumber - 1).viewport;
  const H = 1000 * vp.height / vp.width;
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'mg-svg');
  svg.setAttribute('viewBox', '0 0 1000 ' + H);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg._H = H;
  layer.appendChild(svg);
  return svg;
}
function pathData(shownPoints, H) {
  const f = n => Math.round(n * 10) / 10;
  if (shownPoints.length === 1) return 'M' + f(shownPoints[0][0] * 1000) + ' ' + f(shownPoints[0][1] * H) + 'l0.1 0';
  return shownPoints.map((p, i) => (i ? 'L' : 'M') + f(p[0] * 1000) + ' ' + f(p[1] * H)).join('');
}
function styleInk(path, hl, svg) {
  path.setAttribute('stroke', inkColor(hl));
  path.setAttribute('stroke-width', hl.width * (isSideways() ? svg._H : 1000));
  path.setAttribute('stroke-opacity', hl.tool === 'pen' ? 1 : 0.42);
  path.setAttribute('stroke-linecap', hl.tool === 'pen' ? 'round' : 'butt');
}
function inkPath(hl, svg) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('class', 'mg-ink');
  path.dataset.id = hl.id;
  path.setAttribute('d', pathData(hl.points.map(pointToShown), svg._H));
  styleInk(path, hl, svg);
  return path;
}

function inkBounds(hl) {
  const pts = hl.points.map(pointToShown);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
// Topmost stroke under a point (fx, fy are fractions of the page as shown; ref is the page's box in px).
function inkAt(page, fx, fy, ref) {
  const px = fx * ref.width, py = fy * ref.height;
  let found = null;
  for (const hl of highlights) {
    if (hl.kind !== 'ink' || hl.page !== page || !(hl.points || []).length) continue;
    const tol = Math.max(hl.width * (isSideways() ? ref.height : ref.width) / 2, 7);
    const pts = hl.points.map(pointToShown).map(p => [p[0] * ref.width, p[1] * ref.height]);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[i];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len)) : 0;
      if (Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)) <= tol) { found = hl; break; }
    }
  }
  return found;
}

function eventPoint(e, cur) {
  return [(e.clientX - cur.ref.left) / cur.ref.width, (e.clientY - cur.ref.top) / cur.ref.height];
}
function eraseAt(e) {
  const pageEl = e.target.closest && e.target.closest('.page');
  const page = pageEl && Number(pageEl.dataset.pageNumber);
  const layer = page && layerFor(page, false);
  if (!layer) return;
  const ref = layer.getBoundingClientRect();
  const hit = inkAt(page, (e.clientX - ref.left) / ref.width, (e.clientY - ref.top) / ref.height, ref);
  if (!hit) return;
  highlights = highlights.filter(x => x.id !== hit.id);
  drawPage(page);
  Store.removeHighlight(doc.id, hit.id);
}

container.addEventListener('pointerdown', e => {
  if (!draw.on || !pdf || e.button !== 0) return;
  const pageEl = e.target.closest && e.target.closest('.page');
  if (!pageEl) return;
  e.preventDefault();
  UI.hide();
  if (draw.tool === 'eraser') {
    draw.cur = { erasing: true };
    eraseAt(e);
    return;
  }
  const page = Number(pageEl.dataset.pageNumber);
  const layer = layerFor(page, true);
  const svg = inkSvg(layer, page);
  const ref = layer.getBoundingClientRect();
  const hl = { tool: draw.tool, color: draw.color, width: inkWidth(draw.tool, draw.size[draw.tool]) };
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('class', 'mg-ink');
  styleInk(path, hl, svg);
  svg.appendChild(path);
  draw.cur = { page, svg, ref, hl, path, pts: [] };
  draw.cur.pts.push(eventPoint(e, draw.cur));
  path.setAttribute('d', pathData(draw.cur.pts, svg._H));
  try { container.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
});
container.addEventListener('pointermove', e => {
  const cur = draw.cur;
  if (!cur) return;
  if (cur.erasing) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el) eraseAt({ target: el, clientX: e.clientX, clientY: e.clientY });
    return;
  }
  const p = eventPoint(e, cur), last = cur.pts[cur.pts.length - 1];
  if (Math.hypot((p[0] - last[0]) * cur.ref.width, (p[1] - last[1]) * cur.ref.height) < 2) return;
  cur.pts.push([Math.max(0, Math.min(1, p[0])), Math.max(0, Math.min(1, p[1]))]);
  cur.path.setAttribute('d', pathData(cur.pts, cur.svg._H));
});
async function endStroke() {
  const cur = draw.cur;
  draw.cur = null;
  if (!cur || cur.erasing) return;
  let pts = cur.pts;
  if (cur.hl.tool === 'marker' && pts.length > 2) {
    // Highlighter: a stroke that is nearly a straight line becomes one, and a nearly level one becomes level.
    const a = pts[0], b = pts[pts.length - 1], W = cur.ref.width, Hh = cur.ref.height;
    const ax = a[0] * W, ay = a[1] * Hh, bx = b[0] * W, by = b[1] * Hh, len = Math.hypot(bx - ax, by - ay);
    const strokePx = cur.hl.width * (isSideways() ? Hh : W);
    if (len > 24) {
      const dev = Math.max(...pts.map(p => Math.abs((bx - ax) * (ay - p[1] * Hh) - (ax - p[0] * W) * (by - ay)) / len));
      if (dev < Math.max(strokePx * 0.7, 7)) {
        pts = [a.slice(), b.slice()];
        if (Math.abs(by - ay) < Math.max(strokePx * 0.6, 6)) pts[1][1] = pts[0][1] = (a[1] + b[1]) / 2;
        else if (Math.abs(bx - ax) < Math.max(strokePx * 0.6, 6)) pts[1][0] = pts[0][0] = (a[0] + b[0]) / 2;
      }
    }
  }
  const r4 = n => Math.round(n * 10000) / 10000;
  const hl = await Store.addHighlight(doc, {
    v: 2, kind: 'ink', tool: cur.hl.tool, color: cur.hl.color, width: cur.hl.width, text: '', page: cur.page,
    points: pts.map(pointToBase).map(p => [r4(p[0]), r4(p[1])])
  });
  draw.made.push(hl.id);
  highlights = await Store.getHighlights(doc.id);
  drawAll();
  renderSidebar();
}
container.addEventListener('pointerup', endStroke);
container.addEventListener('pointercancel', endStroke);

function undoInk() {
  const id = draw.made.pop();
  if (id) Store.removeHighlight(doc.id, id);
}

function renderDrawBar() {
  document.body.dataset.tool = draw.tool;
  document.querySelectorAll('#drawBar .seg').forEach(b => b.classList.toggle('on', b.dataset.tool === draw.tool));
  const colors = palette();
  if (!colors.some(c => c.id === draw.color)) draw.color = colors[0].id;
  const box = $('drawColors');
  box.textContent = '';
  for (const c of colors) {
    box.appendChild(h('button', {
      class: c.id === draw.color ? 'on' : '', style: 'background:' + c.hex, title: c.name, 'aria-label': c.name,
      onclick: () => { draw.color = c.id; Store.setSettings({ drawColor: c.id }); renderDrawBar(); }
    }));
  }
  box.appendChild(h('button', {
    class: 'add', title: 'New color for this document', 'aria-label': 'New color for this document',
    onclick: e => UI.showColorForm(e.currentTarget.getBoundingClientRect(), async info => { draw.color = (await addDocColor(info)).id; renderDrawBar(); })
  }, '+'));
  box.style.visibility = $('drawSize').style.visibility = draw.tool === 'eraser' ? 'hidden' : 'visible';
  if (draw.tool !== 'eraser') $('drawSize').value = draw.size[draw.tool];
}
function setDrawing(on) {
  if (on && !pdf) return;
  draw.on = on;
  draw.cur = null;
  document.body.classList.toggle('drawing', on);
  $('drawBar').hidden = !on;
  $('drawBtn').setAttribute('aria-pressed', String(on));
  if (on) {
    UI.hide();
    getSelection().removeAllRanges();
    renderDrawBar();
  }
}
$('drawBtn').addEventListener('click', () => setDrawing(!draw.on));
$('drawDone').addEventListener('click', () => setDrawing(false));
$('drawUndo').addEventListener('click', undoInk);
document.querySelectorAll('#drawBar .seg').forEach(b => b.addEventListener('click', () => {
  draw.tool = b.dataset.tool;
  if (draw.tool !== 'eraser') Store.setSettings({ drawTool: draw.tool });
  renderDrawBar();
}));
$('drawSize').addEventListener('input', e => {
  if (draw.tool === 'eraser') return;
  draw.size[draw.tool] = Number(e.target.value);
  Store.setSettings(draw.tool === 'pen' ? { penSize: draw.size.pen } : { markerSize: draw.size.marker });
});

// Scanned PDFs have no text to select; point the reader at the pen once per document.
// ------------------------------------------------------------------ text recognition (scanned pages)
// A page that is only an image has nothing to select. Such pages are read with a bundled OCR engine
// (Tesseract, runs locally) and the recognized words are laid over the page as an invisible, selectable
// layer - after which highlighting, translating and saving words work as on any other page.
const ocr = { worker: null, workerLang: '', loading: null, queue: [], busy: false, pages: new Map(), scanned: new Map(), idle: null, told: false };
const ocrLang = () => settings.ocr || 'eng';
const ocrKey = p => 'ocr:' + doc.id + ':' + p;

async function isScanned(p) {
  if (ocr.scanned.has(p)) return ocr.scanned.get(p);
  let chars = 0;
  try {
    for (const it of (await (await pdf.getPage(p)).getTextContent()).items) chars += (it.str || '').trim().length;
  } catch (e) { chars = 99; }
  ocr.scanned.set(p, chars < 12);
  return chars < 12;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(el);
  });
}
async function ocrWorker(lang) {
  if (ocr.worker && ocr.workerLang === lang) return ocr.worker;
  if (ocr.worker) { try { await ocr.worker.terminate(); } catch (e) { /* gone */ } ocr.worker = null; }
  if (!globalThis.Tesseract) await loadScript(chrome.runtime.getURL('ocr/tesseract.min.js'));
  ocr.worker = await globalThis.Tesseract.createWorker(lang.split('+'), 1, {
    workerPath: chrome.runtime.getURL('ocr/worker.min.js'), corePath: chrome.runtime.getURL('ocr/'),
    langPath: chrome.runtime.getURL('ocr/lang/'), workerBlobURL: false, gzip: true
  });
  ocr.workerLang = lang;
  return ocr.worker;
}
function ocrStatus(text) {
  const el = $('ocrStatus');
  el.hidden = !text;
  el.textContent = text || '';
}

let measureCtx = null;
function naturalWidth(text) { // width of text at 100px, in the font the layer uses
  if (!measureCtx) { measureCtx = document.createElement('canvas').getContext('2d'); measureCtx.font = '100px sans-serif'; }
  return measureCtx.measureText(text).width || 1;
}

// Lays the recognized words over the page. Sizes use PDF.js's --scale-factor, so they follow zooming.
function injectOcr(p) {
  const data = ocr.pages.get(p);
  const pv = viewer.getPageView(p - 1);
  if (!data || !pv || !pv.div || pv.div.querySelector(':scope > .mg-ocr')) return;
  const layer = h('div', { class: 'textLayer mg-ocr' });
  layer.dataset.mainRotation = viewer.pagesRotation;
  layer.style.cssText = 'inset:auto;left:0;top:0;width:calc(var(--scale-factor) * ' + data.w + 'px);height:calc(var(--scale-factor) * ' + data.h + 'px)';
  data.lines.forEach((line, li) => {
    const size = line.h * data.h; // line height in PDF points
    line.words.forEach((w, i) => {
      const next = line.words[i + 1];
      const text = w[0] + ' ';
      const target = (next ? next[1] - w[1] : w[2]) * data.w;
      const k = target / (naturalWidth(next ? text : w[0]) * size / 100);
      const span = document.createElement('span');
      span.dataset.l = li;
      span.dataset.w = i;
      span.textContent = text;
      span.style.cssText = 'left:' + (w[1] * 100).toFixed(3) + '%;top:' + (line.y * 100).toFixed(3) + '%;font-family:sans-serif;font-size:calc(var(--scale-factor) * ' +
        size.toFixed(2) + 'px);transform:scaleX(' + k.toFixed(4) + ')';
      layer.appendChild(span);
    });
    layer.appendChild(document.createElement('br'));
  });
  pv.div.appendChild(layer);
  markFound(p);
}

async function recognizePage(p) {
  const forDoc = doc.id, lang = ocrLang();
  const page = await pdf.getPage(p);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.min(3.2, Math.max(1.5, 2200 / base.width)) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d', { willReadFrequently: true }), viewport: vp }).promise;
  const worker = await ocrWorker(lang);
  const { data } = await worker.recognize(canvas);
  const W = canvas.width, H = canvas.height, r = n => Math.round(n * 1e4) / 1e4;
  const lines = [];
  for (const l of data.lines || []) {
    const words = (l.words || []).filter(w => w.confidence >= 25 && w.text && w.text.trim())
      .map(w => [w.text.trim(), r(w.bbox.x0 / W), r((w.bbox.x1 - w.bbox.x0) / W)]);
    if (words.length) lines.push({ y: r(l.bbox.y0 / H), h: r((l.bbox.y1 - l.bbox.y0) / H), words });
  }
  canvas.width = canvas.height = 0;
  if (!doc || doc.id !== forDoc) return;
  const result = { v: 1, lang, w: r(base.width), h: r(base.height), lines };
  ocr.pages.set(p, result);
  injectOcr(p);
  if (ofind.query) searchOcr(false);
  // Remember the result so the page is not read again next time; keep only the 12 most recent documents.
  try {
    const idx = (await chrome.storage.local.get('_ocrDocs'))._ocrDocs || {};
    idx[doc.id] = Date.now();
    const old = Object.keys(idx).sort((a, b) => idx[b] - idx[a]).slice(12);
    if (old.length) {
      const all = Object.keys(await chrome.storage.local.get(null));
      await chrome.storage.local.remove(all.filter(k => old.some(id => k.startsWith('ocr:' + id + ':'))));
      old.forEach(id => delete idx[id]);
    }
    await chrome.storage.local.set({ [ocrKey(p)]: result, _ocrDocs: idx });
  } catch (e) { /* cache is optional */ }
}

async function pumpOcr() {
  if (ocr.busy || !ocr.queue.length || !doc) return;
  ocr.busy = true;
  clearTimeout(ocr.idle);
  // nearest page to the one being read goes first
  const cur = viewer.currentPageNumber || 1;
  // Pages scrolled past are dropped (they are picked up again when you return); a search reads everything.
  if (!ofind.queuedAll) ocr.queue = ocr.queue.filter(p => Math.abs(p - cur) <= 2);
  if (!ocr.queue.length) { ocr.busy = false; ocrStatus(''); return; }
  ocr.queue.sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur));
  const p = ocr.queue.shift();
  ocrStatus('Reading the text on page ' + p + '...');
  try {
    await recognizePage(p);
  } catch (e) {
    console.warn('Margin: text recognition failed', e);
    ocrStatus('');
    UI.toast('Could not read the text on this page.');
  }
  ocr.busy = false;
  if (ocr.queue.length) return pumpOcr();
  ocrStatus('');
  if (ofind.query) showOcrCount();
  ocr.idle = setTimeout(() => { if (ocr.worker && !ocr.busy) { ocr.worker.terminate(); ocr.worker = null; } }, 90000);
}

async function maybeRecognize(p) {
  if (!doc || ocrLang() === 'off') return;
  const forDoc = doc.id;
  if (ocr.pages.has(p)) return injectOcr(p);
  if (!(await isScanned(p)) || !doc || doc.id !== forDoc) return;
  const saved = (await chrome.storage.local.get(ocrKey(p)))[ocrKey(p)];
  if (!doc || doc.id !== forDoc) return;
  if (saved && saved.v === 1 && saved.lang === ocrLang()) {
    ocr.pages.set(p, saved);
    return injectOcr(p);
  }
  if (!ocr.told) {
    ocr.told = true;
    UI.toast('Scanned page: reading its text so you can select and translate it.');
  }
  if (!ocr.queue.includes(p)) ocr.queue.push(p);
  pumpOcr();
}
// ---- Find inside recognized text. PDF.js can only search text stored in the file, so scanned documents
// are searched here instead; the first search reads every page in the background.
const ofind = { query: '', matches: [], index: -1, queuedAll: false, scannedDoc: null };
const fold = t => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

async function isScannedDoc() {
  if (ofind.scannedDoc === null) {
    const n = pdf.numPages, sample = [...new Set([1, Math.min(2, n), Math.ceil(n / 2)])];
    let hits = 0;
    for (const p of sample) if (await isScanned(p)) hits++;
    ofind.scannedDoc = hits >= Math.ceil(sample.length / 2);
  }
  return ofind.scannedDoc;
}
async function readAllPages() {
  if (ofind.queuedAll) return;
  ofind.queuedAll = true;
  const forDoc = doc.id;
  const stored = await chrome.storage.local.get(null);
  for (let p = 1; p <= pdf.numPages; p++) {
    if (!doc || doc.id !== forDoc) return;
    if (ocr.pages.has(p)) continue;
    const saved = stored[ocrKey(p)];
    if (saved && saved.v === 1 && saved.lang === ocrLang()) { ocr.pages.set(p, saved); continue; }
    if ((await isScanned(p)) && !ocr.queue.includes(p)) ocr.queue.push(p);
  }
  searchOcr(false);
  pumpOcr();
}
function showOcrCount() {
  const reading = ocr.busy || ocr.queue.length;
  const n = ofind.matches.length;
  $('findCount').textContent = !ofind.query ? '' : n ? (ofind.index + 1) + ' / ' + n + (reading ? '...' : '') : reading ? 'Reading pages...' : 'No results';
}
function markFound(only) {
  document.querySelectorAll(only ? '.page[data-page-number="' + only + '"] .mg-found' : '.mg-found').forEach(el => el.classList.remove('mg-found', 'mg-current'));
  ofind.matches.forEach((m, i) => {
    if (only && m.page !== only) return;
    const layer = document.querySelector('.page[data-page-number="' + m.page + '"] > .mg-ocr');
    if (!layer) return;
    for (let w = m.a; w <= m.b; w++) {
      const span = layer.querySelector('span[data-l="' + m.line + '"][data-w="' + w + '"]');
      if (span) span.classList.add('mg-found', ...(i === ofind.index ? ['mg-current'] : []));
    }
  });
}
// Rebuilds the match list from every page read so far; keeps the current match selected when possible.
function searchOcr(jump) {
  const q = fold(ofind.query).trim();
  const current = ofind.matches[ofind.index];
  ofind.matches = [];
  if (q) {
    for (const p of [...ocr.pages.keys()].sort((a, b) => a - b)) {
      ocr.pages.get(p).lines.forEach((line, li) => {
        const starts = [];
        let text = '';
        line.words.forEach(w => { starts.push(text.length); text += fold(w[0]) + ' '; });
        let at = text.indexOf(q);
        while (at !== -1) {
          const end = at + q.length - 1;
          let a = 0, b = 0;
          starts.forEach((s, i) => { if (s <= at) a = i; if (s <= end) b = i; });
          ofind.matches.push({ page: p, line: li, a, b });
          at = text.indexOf(q, at + 1);
        }
      });
    }
  }
  const same = current && ofind.matches.findIndex(m => m.page === current.page && m.line === current.line && m.a === current.a);
  if (same != null && same >= 0) ofind.index = same;
  else {
    const cur = viewer.currentPageNumber || 1;
    ofind.index = ofind.matches.length ? Math.max(0, ofind.matches.findIndex(m => m.page >= cur)) : -1;
    if (jump && ofind.index >= 0) goToFound();
  }
  markFound();
  showOcrCount();
}
function goToFound() {
  const m = ofind.matches[ofind.index];
  if (!m) return;
  const pv = viewer.getPageView(m.page - 1), line = ocr.pages.get(m.page).lines[m.line];
  if (pv && viewer.pagesRotation === 0) glide(pv.div.offsetTop + pv.div.clientTop + line.y * pv.div.clientHeight - container.clientHeight / 3);
  else viewer.currentPageNumber = m.page;
  setTimeout(() => markFound(), 120);
}
async function ocrFind(query, again, previous) {
  if (!again || query !== ofind.query) {
    ofind.query = query;
    ofind.index = -1;
    if (!query) { ofind.matches = []; markFound(); showOcrCount(); return; }
    searchOcr(true);
    readAllPages();
    return;
  }
  const n = ofind.matches.length;
  if (!n) return;
  ofind.index = (ofind.index + (previous ? -1 : 1) + n) % n;
  goToFound();
  showOcrCount();
}

function resetOcr() {
  ofind.query = '';
  ofind.matches = [];
  ofind.index = -1;
  ofind.queuedAll = false;
  ofind.scannedDoc = null;
  ocr.queue = [];
  ocr.pages = new Map();
  ocr.scanned = new Map();
  ocr.told = false;
  ocrStatus('');
}

// With recognition switched off, scanned PDFs can still be marked by hand.
async function hintIfScanned() {
  if (ocrLang() !== 'off') return;
  try {
    if (await isScanned(1)) UI.toast('This page has no selectable text - use the pen in the toolbar to mark it.');
  } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------------ sidebar
// Where a mark starts on its page (unrotated fractions), for ordering and jumping.
function anchorOf(hl) {
  if ((hl.rects || []).length) return hl.rects[0];
  if ((hl.points || []).length) {
    return { page: hl.page, x: Math.min(...hl.points.map(p => p[0])), y: Math.min(...hl.points.map(p => p[1])), w: 0, h: 0 };
  }
  return null;
}

// Scrolls the document to a position. Nearby places glide; far ones jump most of the way first,
// so a long document does not have to be drawn page by page on the way there. -> true when it jumped
const calm = { get matches() { return document.documentElement.dataset.motion === 'off'; } }; // see theme.js
function glide(top) {
  top = Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight));
  const gap = top - container.scrollTop, view = container.clientHeight;
  if (calm.matches || Math.abs(gap) < 2) { container.scrollTop = top; return true; }
  const far = Math.abs(gap) > view * 1.5;
  if (far) container.scrollTop = top - Math.sign(gap) * view * 0.6;
  container.scrollTo({ top, behavior: 'smooth' });
  return far;
}

function jumpTo(hl) {
  const base = anchorOf(hl);
  if (!base) return;
  const pv = viewer.getPageView(base.page - 1);
  if (!pv) return;
  const y = pv.div.offsetTop + pv.div.clientTop + toShown(baseRect(hl, base)).y * pv.div.clientHeight;
  const far = glide(y - container.clientHeight / 3);
  let tries = 0;
  const flash = () => {
    const els = document.querySelectorAll('.mg-rect[data-id="' + hl.id + '"], .mg-ink[data-id="' + hl.id + '"]');
    if (!els.length && ++tries < 15) return setTimeout(flash, 150);
    els.forEach(el => { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); });
  };
  setTimeout(flash, far ? 60 : 260);
}

// Printed page number for a PDF page: the file's own page labels, else the offset from the citation details.
function printedPage(p) {
  const label = pageLabels && pageLabels[p - 1];
  if (label && /^[0-9ivxlcdm]+$/i.test(label)) return label;
  const first = cite && cite.meta && Number(cite.meta.firstPage);
  return first ? String(first + p - 1) : String(p);
}

function inlineEdit(el, value, onSave) {
  const input = h('input', { class: 'lg-input', type: 'text', maxlength: '40' });
  input.value = value;
  el.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = save => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== value) onSave(v); else renderSidebar();
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false);
  });
}
function saveColor(c, patch) {
  if (c.scope === 'global') return Store.saveGlobalColor(c.id, patch);
  return Store.saveDocColor(doc, { id: c.id, hex: patch.hex || c.hex, name: patch.name || c.name });
}

// What each color means. Names are yours: the first four apply everywhere, the rest only to this document.
function renderLegend(box, counts) {
  const wrap = h('div', { class: 'legend' });
  for (const c of palette()) {
    const picker = h('input', { class: 'lg-dot', type: 'color', value: c.hex, title: 'Change this color', 'aria-label': 'Change color of ' + c.name });
    picker.addEventListener('change', () => saveColor(c, { hex: picker.value }));
    const name = h('button', { class: 'lg-name', title: 'Click to rename' }, c.name);
    name.addEventListener('click', () => inlineEdit(name, c.name, v => saveColor(c, { name: v })));
    wrap.appendChild(h('div', { class: 'lg-row' },
      picker, name,
      c.scope === 'doc' ? h('span', { class: 'lg-tag', title: 'Only in this document' }, 'this file') : null,
      h('span', { class: 'lg-n' }, String(counts[c.id] || 0)),
      c.scope === 'doc' && !counts[c.id] && c.id.startsWith('c-')
        ? h('button', { class: 'lg-x', title: 'Remove this color', 'aria-label': 'Remove ' + c.name, onclick: () => Store.removeDocColor(doc.id, c.id) }, '×') : null));
  }
  wrap.appendChild(h('button', {
    class: 'lg-add',
    onclick: e => UI.showColorForm(e.currentTarget.getBoundingClientRect(), addDocColor)
  }, '+ New color for this document'));
  box.appendChild(wrap);
}

function highlightCard(hl, showPage) {
  const vocab = hl.kind === 'vocab';
  const hex = vocab ? '#2f8f76' : hexOf(hl.color);
  const card = h('div', { class: 'item' + (vocab ? ' vocab' : ''), style: '--c:' + hex, onclick: () => jumpTo(hl) },
    h('div', { class: 'body' },
      showPage ? h('div', { class: 'where' }, 'p. ' + printedPage(hl.page)) : null,
      h('div', { class: 'text' + (hl.text ? '' : ' muted') }, hl.text || (hl.tool === 'pen' ? 'Pen mark' : 'Highlighter mark')),
      hl.note ? h('div', { class: 'note' }, hl.note) : null,
      h('div', { class: 'meta' },
        h('button', { onclick: e => { e.stopPropagation(); openEditor(hl, e.currentTarget.getBoundingClientRect(), { focusNote: true }); } }, hl.note ? 'Edit note' : 'Add note'),
        hl.text ? h('button', { title: 'Copy the quotation with an in-text citation', onclick: e => { e.stopPropagation(); copyQuote(hl); } }, 'Copy quote') : null,
        h('button', { onclick: e => { e.stopPropagation(); Store.removeHighlight(doc.id, hl.id); } }, 'Delete')
      )
    ));
  return card;
}

function renderSidebar() {
  const list = $('hlList');
  list.textContent = '';
  $('hlCount').textContent = highlights.length > 99 ? '99+' : String(highlights.length);
  $('hlCount').hidden = !highlights.length;
  const counts = {};
  for (const hl of highlights) if (hl.kind !== 'vocab') counts[hl.color] = (counts[hl.color] || 0) + 1;
  if (doc) renderLegend(list, counts);
  if (!highlights.length) {
    list.appendChild(h('div', { class: 'hint' }, 'Select text in the document to highlight it, add a note, or translate a word. Everything you mark appears here, sorted by what each color means.'));
    return;
  }
  const sorted = highlights.slice().sort((a, b) => {
    const ra = anchorOf(a) || {}, rb = anchorOf(b) || {};
    return (a.page - b.page) || (ra.y - rb.y) || (ra.x - rb.x);
  });
  const byColor = settings.sidebarGroup !== 'page';
  const seg = (id, label) => h('button', { class: 'gseg' + ((id === 'color') === byColor ? ' on' : ''), onclick: () => Store.setSettings({ sidebarGroup: id }) }, label);
  list.appendChild(h('div', { class: 'listbar' },
    h('div', { class: 'grouping' }, seg('color', 'By color'), seg('page', 'By page')),
    globalThis.MarginExport.menu(async () => ({
      title: doc.title, source: sourceUrl || doc.fileName || '', highlights: sorted, palette: palette(), pageOf: hl => printedPage(hl.page),
      vocab: await Store.listVocab(), citation: cite && cite.source !== 'pdf' ? Cite.formatCitation(cite.meta, citeStyle()) : null
    }), msg => UI.toast(msg), [['pdf', 'PDF with highlights (.pdf)', savePdfCopy]])));

  if (byColor) {
    for (const c of palette()) {
      const items = sorted.filter(hl => hl.kind !== 'vocab' && hl.color === c.id);
      if (!items.length) continue;
      list.appendChild(h('div', { class: 'grouphead' }, h('span', { class: 'gdot', style: 'background:' + c.hex }), h('span', { class: 'gname' }, c.name), h('span', { class: 'gcount' }, String(items.length))));
      items.forEach(hl => list.appendChild(highlightCard(hl, true)));
    }
    const words = sorted.filter(hl => hl.kind === 'vocab');
    if (words.length) {
      list.appendChild(h('div', { class: 'grouphead' }, h('span', { class: 'gdot vocab' }), h('span', { class: 'gname' }, 'Saved words'), h('span', { class: 'gcount' }, String(words.length))));
      words.forEach(hl => list.appendChild(highlightCard(hl, true)));
    }
  } else {
    let lastPage = 0;
    for (const hl of sorted) {
      if (hl.page !== lastPage) {
        lastPage = hl.page;
        list.appendChild(h('div', { class: 'grouphead' }, h('span', { class: 'gname' }, 'Page ' + printedPage(hl.page))));
      }
      list.appendChild(highlightCard(hl, false));
    }
  }
}

// ------------------------------------------------------------------ PDF copy with the highlights inside
async function savePdfCopy() {
  UI.toast('Writing your highlights into a copy of the PDF...');
  if (!globalThis.PDFLib) await loadScript(chrome.runtime.getURL('reader/pdf-lib.min.js'));
  const { annotatedPdf } = await import('./annotate.js');
  let result;
  try {
    result = await annotatedPdf({
      PDFLib: globalThis.PDFLib, bytes: await pdf.getData(), pdf, highlights, vocab: await Store.listVocab(),
      hexOf, labelOf: id => colorOf(id).name
    });
  } catch (e) {
    if (/encrypt/i.test(String(e && e.message))) return 'This PDF is password-protected, so a copy cannot be written. Word or Markdown export still works.';
    throw e;
  }
  const name = globalThis.MarginExport.fileName(doc.title, 'pdf').replace(/ - notes\.pdf$/, ' (with highlights).pdf');
  globalThis.MarginExport.download(new Blob([result.bytes], { type: 'application/pdf' }), name);
  return result.count + ' highlight' + (result.count === 1 ? '' : 's') + ' saved into a PDF copy in your downloads';
}

// ------------------------------------------------------------------ citation
let cite = null; // { meta, source: 'doi' | 'title' | 'pdf' | 'manual' }
const citeStyle = () => (Cite.STYLES.some(s => s[0] === settings.citeStyle) ? settings.citeStyle : 'apa');

async function copyRich(html, text) {
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' })
    })]);
  } catch (e) {
    try { await navigator.clipboard.writeText(text); } catch (e2) {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }
}
function copyQuote(hl) {
  const ref = cite ? ' ' + Cite.inText(cite.meta, citeStyle(), printedPage(hl.page)) : '';
  const text = '“' + hl.text + '”' + ref;
  copyRich(text.replace(/&/g, '&amp;').replace(/</g, '&lt;'), text);
  UI.toast('Quote copied' + (ref ? ' with citation' : ''));
}

function metaFromPdf() {
  const author = String(pdfInfo.Author || '').trim();
  const plausible = author && author.length < 120 && !/\d|\.(com|org|net)\b|acrobat|microsoft|adobe|user|admin/i.test(author);
  return {
    type: 'other', authors: plausible ? Cite.parseNames(author.replace(/,\s*(?=\p{Lu})/gu, '; ')) : [], editors: [],
    title: doc.title, container: '', publisher: '', year: '', volume: '', issue: '', pages: '', doi: '',
    url: /^https?:/i.test(sourceUrl) ? sourceUrl : '', firstPage: 0
  };
}
async function firstPagesText() {
  let text = '';
  for (let p = 1; p <= Math.min(2, pdf.numPages); p++) {
    try { text += (await (await pdf.getPage(p)).getTextContent()).items.map(i => i.str).join(' ') + '\n'; } catch (e) { /* skip */ }
  }
  return text;
}
const saveCite = () => { delete cite.pending; delete cite.looking; cite.at = Date.now(); return chrome.storage.local.set({ ['cite:' + doc.id]: cite }); };

// Finds the published record for this PDF: a DOI printed in the file first, then a title search.
async function lookupCite() {
  const forDoc = doc.id;
  const base = metaFromPdf();
  const ask = q => chrome.runtime.sendMessage(Object.assign({ type: 'crossref' }, q)).catch(() => ({ ok: false, items: [] }));
  const adopt = (item, source) => {
    const meta = Cite.fromCrossref(item);
    if (!meta.authors.length) meta.authors = base.authors;
    meta.url = base.url;
    meta.firstPage = Cite.inferFirstPage(meta.pages, pdf.numPages);
    return { meta, source };
  };
  let found = null, failed = false;
  const doi = Cite.findDoi(pdfInfo.doi || pdfInfo.DOI || '') || Cite.findDoi(pdfInfo.Subject || '') || Cite.findDoi(await firstPagesText());
  if (doi) {
    const r = await ask({ doi });
    failed = !r.ok;
    const it = r.items[0];
    // A DOI printed on the first pages can belong to a cited work, so the title has to agree.
    if (it && (titleSource === 'file' || Cite.similarity((it.title || [])[0], doc.title) >= 0.45)) found = adopt(it, 'doi');
  }
  if (!found && titleSource !== 'file') {
    const r = await ask({ query: doc.title + (base.authors[0] ? ' ' + base.authors[0].family : '') });
    failed = failed || !r.ok;
    const best = r.items.map(it => [Cite.similarity((it.title || [])[0], doc.title), it]).sort((a, b) => b[0] - a[0])[0];
    if (best && best[0] >= 0.75) found = adopt(best[1], 'title');
  }
  if (!doc || doc.id !== forDoc) return;
  cite = found || { meta: base, source: 'pdf' };
  if (found || !failed) saveCite();
  renderCite(failed && !found ? 'Could not reach Crossref - check your connection, then use Look up again.' : '');
  renderSidebar();
}

async function loadCite() {
  const key = 'cite:' + doc.id;
  const saved = (await chrome.storage.local.get(key))[key];
  if (saved && saved.meta) {
    cite = saved;
    renderCite();
    renderSidebar();
    return;
  }
  // Nothing is asked of Crossref until the Cite panel is opened: until then these are just the file's own details.
  cite = { meta: metaFromPdf(), source: 'pdf', pending: true };
  renderCite();
  if (!$('cite').hidden && !document.body.classList.contains('noside')) needCite();
}
function needCite() {
  if (!cite || !cite.pending) return;
  cite.pending = false;
  cite.looking = true;
  renderCite();
  lookupCite();
}

const FIELDS = [
  ['authors', 'Authors', 'Family, Given; Family, Given'], ['title', 'Title', ''], ['container', 'Journal or book title', ''],
  ['editors', 'Editors (for a chapter)', 'Family, Given; Family, Given'], ['publisher', 'Publisher', ''], ['year', 'Year', ''],
  ['volume', 'Volume', ''], ['issue', 'Issue', ''], ['pages', 'Pages', '81-115'], ['doi', 'DOI', '10.xxxx/...'],
  ['firstPage', 'Printed number of PDF page 1', 'e.g. 81']
];
function citeForm() {
  const m = cite.meta;
  const type = h('select', { class: 'cf-in' }, [['article', 'Journal article'], ['chapter', 'Book chapter'], ['book', 'Book'], ['other', 'Other']].map(([v, l]) => h('option', { value: v }, l)));
  type.value = m.type || 'other';
  const inputs = {};
  const form = h('div', { class: 'citeform' }, h('label', null, 'Type', type));
  for (const [key, label, ph] of FIELDS) {
    const input = h('input', { class: 'cf-in', type: 'text', placeholder: ph });
    input.value = key === 'authors' || key === 'editors' ? Cite.namesToText(m[key]) : (m[key] || '');
    input.addEventListener('keydown', e => e.stopPropagation());
    inputs[key] = input;
    form.appendChild(h('label', null, label, input));
  }
  form.appendChild(h('div', { class: 'cf-foot' },
    h('button', { class: 'btn', onclick: () => renderCite() }, 'Cancel'),
    h('button', { class: 'btn pri', onclick: () => {
      const meta = { type: type.value, url: m.url || '' };
      for (const [key] of FIELDS) {
        const v = inputs[key].value.trim();
        meta[key] = key === 'authors' || key === 'editors' ? Cite.parseNames(v) : key === 'firstPage' ? (parseInt(v, 10) || 0) : key === 'doi' ? (Cite.findDoi(v) || v) : v;
      }
      cite = { meta, source: 'manual' };
      saveCite();
      renderCite();
      renderSidebar();
    } }, 'Save')));
  return form;
}

function renderCite(status, editing) {
  const box = $('cite');
  box.textContent = '';
  if (!doc || !cite) return;
  const style = citeStyle();
  const out = Cite.formatCitation(cite.meta, style);
  const where = { doi: 'Matched on Crossref by the DOI in this file.', title: 'Matched on Crossref by title. Check that it is the right work.', manual: 'Details edited by you.',
    pdf: 'No published record found. These details come from the file itself - fill in what is missing.' }[cite.source] || '';
  const sel = h('select', { class: 'cf-in', 'aria-label': 'Citation style' }, Cite.STYLES.map(([v, l]) => h('option', { value: v }, l)));
  sel.value = style;
  sel.addEventListener('change', () => Store.setSettings({ citeStyle: sel.value }));
  const result = h('div', { class: 'citebox' });
  Cite.renderCitation(result, out.html);
  const ref = Cite.inText(cite.meta, style, printedPage(viewer.currentPageNumber || 1));
  const q = cite.meta.title + (cite.meta.authors && cite.meta.authors[0] ? ' ' + cite.meta.authors[0].family : '');
  box.appendChild(h('div', { class: 'citepanel' },
    h('div', { class: 'cite-src' }, status || (cite.looking ? 'Looking for this work on Crossref...' : where)),
    h('div', { class: 'cite-row' }, h('span', { class: 'cite-lbl' }, 'Style'), sel),
    result,
    h('div', { class: 'cite-actions' },
      h('button', { class: 'btn pri', onclick: () => { copyRich(out.html, out.text); UI.toast('Citation copied'); } }, 'Copy citation'),
      h('button', { class: 'btn', title: 'For the page you are on', onclick: () => { copyRich(ref, ref); UI.toast('In-text citation copied'); } }, 'Copy ' + ref)),
    h('div', { class: 'cite-links' },
      h('a', { href: 'https://scholar.google.com/scholar?q=' + encodeURIComponent(q), target: '_blank', rel: 'noopener' }, 'Find on Google Scholar'),
      cite.meta.doi ? h('a', { href: 'https://doi.org/' + cite.meta.doi, target: '_blank', rel: 'noopener' }, 'Open DOI page') : null,
      h('a', { href: '#', onclick: e => { e.preventDefault(); renderCite('', true); } }, 'Edit details'),
      h('a', { href: '#', onclick: e => { e.preventDefault(); cite.looking = true; renderCite(); lookupCite(); } }, 'Look up again')),
    editing ? citeForm() : null,
    h('div', { class: 'cite-note' }, 'Titles are kept as published; APA asks for sentence case, so adjust capitals if your instructor requires it.')));
  if (editing) box.querySelector('.citeform').scrollIntoView({ block: 'start' });
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  $('hlList').hidden = name !== 'hl';
  $('outline').hidden = name !== 'outline';
  $('cite').hidden = name !== 'cite';
  $('thumbs').hidden = name !== 'thumbs';
  $('panelTitle').textContent = { hl: 'Notes', outline: 'Sections', thumbs: 'Thumbnails', cite: 'Cite' }[name] || '';
  if (name === 'cite' && cite) { renderCite(); needCite(); }
  if (name === 'thumbs') renderThumbs();
}
// The side panel is closed by default so the document has the whole window; the tabs on the edge open it.
function openPanel(name, remember) {
  document.body.classList.remove('noside');
  showTab(name);
  if (remember !== false) Store.setSettings({ readerPanel: name });
  settle();
}
function closePanel(remember) {
  document.body.classList.add('noside');
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
  if (remember !== false) Store.setSettings({ readerPanel: '' });
  settle();
}
// Fit the page to its new width once the panel has finished sliding (at once when nothing is moving).
let settleTimer = 0;
function settle() {
  clearTimeout(settleTimer);
  if (!document.body.classList.contains('anim') || calm.matches) { resetPad(); refit(); return; }
  settleTimer = setTimeout(() => { resetPad(); refit(); }, 230);
}
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  if (tab.classList.contains('on') && !document.body.classList.contains('noside')) closePanel(); else openPanel(tab.dataset.tab);
}));
$('panelClose').addEventListener('click', () => closePanel());
$('citeBtn').addEventListener('click', () => openPanel('cite'));

// Page thumbnails, drawn only as they scroll into view.
let thumbsFor = null, thumbWatch = null;
async function renderThumbs() {
  const box = $('thumbs');
  if (!pdf) return;
  if (thumbsFor !== doc.id) {
    thumbsFor = doc.id;
    box.textContent = '';
    if (thumbWatch) thumbWatch.disconnect();
    const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
    const forDoc = doc.id;
    thumbWatch = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        thumbWatch.unobserve(en.target);
        (async el => {
          const page = await pdf.getPage(Number(el.dataset.p));
          if (!doc || doc.id !== forDoc) return;
          const vp = page.getViewport({ scale: 150 * Math.min(2, devicePixelRatio || 1) / page.getViewport({ scale: 1 }).width });
          const canvas = el.querySelector('canvas');
          canvas.width = Math.round(vp.width);
          canvas.height = Math.round(vp.height);
          canvas.style.height = '';
          try { await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise; } catch (e) { /* page went away */ }
        })(en.target);
      }
    }, { root: box, rootMargin: '400px 0px' });
    for (let p = 1; p <= pdf.numPages; p++) {
      const canvas = h('canvas');
      canvas.style.height = Math.round(150 * first.height / first.width) + 'px';
      const el = h('button', { class: 'thumb', 'data-p': p, 'aria-label': 'Page ' + p, onclick: () => { viewer.currentPageNumber = p; } }, canvas, h('span', null, String(p)));
      box.appendChild(el);
      thumbWatch.observe(el);
    }
  }
  markThumb(true);
}
function markThumb(scroll) {
  const box = $('thumbs');
  if (box.hidden) return;
  const cur = viewer.currentPageNumber || 1;
  box.querySelectorAll('.thumb.on').forEach(t => t.classList.remove('on'));
  const el = box.querySelector('.thumb[data-p="' + cur + '"]');
  if (!el) return;
  el.classList.add('on');
  if (scroll || el.offsetTop < box.scrollTop || el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, el.offsetTop - box.clientHeight / 3);
}

async function renderOutline() {
  const box = $('outline');
  box.textContent = '';
  let outline = null;
  try { outline = await pdf.getOutline(); } catch (e) { /* none */ }
  if (!outline || !outline.length) {
    box.appendChild(h('div', { class: 'hint' }, 'This document has no outline.'));
    return;
  }
  const build = items => h('ul', { class: 'ol' }, items.map(it =>
    h('li', null,
      h('a', { onclick: () => { if (it.dest) linkService.goToDestination(it.dest); } }, it.title || 'Untitled'),
      it.items && it.items.length ? build(it.items) : null)));
  box.appendChild(build(outline));
}

// Keep in sync with edits made here, in the editor popover, or from the dashboard.
chrome.storage.onChanged.addListener(changes => {
  let redraw = false;
  if (changes.settings) { settings = Object.assign({}, Store.DEFAULTS, changes.settings.newValue || {}); redraw = true; }
  if (doc && changes['doc:' + doc.id]) { docRecord = changes['doc:' + doc.id].newValue || null; redraw = true; }
  if (doc && changes['hl:' + doc.id]) { highlights = changes['hl:' + doc.id].newValue || []; redraw = true; }
  if (redraw && doc) {
    drawAll();
    renderSidebar();
    if (draw.on) renderDrawBar();
    if (changes.settings && !$('cite').hidden && !$('cite').querySelector('.citeform')) renderCite();
  }
});

// ------------------------------------------------------------------ toolbar
const refit = () => {
  const v = viewer.currentScaleValue;
  if (pdf && (v === 'auto' || v === 'page-width' || v === 'page-fit')) viewer.currentScaleValue = v;
};
window.addEventListener('resize', refit);

$('open2').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', e => { openFile(e.target.files[0]); e.target.value = ''; });
$('prev').addEventListener('click', () => viewer.previousPage());
$('next').addEventListener('click', () => viewer.nextPage());
$('pageNum').addEventListener('change', e => {
  const n = Math.max(1, Math.min(pdf ? pdf.numPages : 1, parseInt(e.target.value, 10) || viewer.currentPageNumber));
  viewer.currentPageNumber = n;
  e.target.value = n;
});
$('pageNum').addEventListener('focus', e => e.target.select());
$('pageNum').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
// ------------------------------------------------------------------ zoom
// Zooming keeps one point of the document fixed on screen: the point under the pointer (wheel, pinch, keyboard
// while the pointer is over the document) or the middle of the window (the + and - buttons).
// The point is remembered as a place on its page, the scale changes, and the document is scrolled so that the
// same place is under the same screen position again. (When a page is narrower than the window it stays centered,
// so only the vertical position can be held; the same goes for the very top and bottom of the document.)
const MIN_SCALE = 0.1, MAX_SCALE = 10;
const pointer = { x: 0, y: 0, over: false };
const hold = { page: null, fx: 0, fy: 0, x: 0, y: 0, at: 0 };
container.addEventListener('scroll', () => { if (Date.now() >= placeQuiet) hold.page = null; }, { passive: true }); // the reader scrolled: new anchor
container.addEventListener('mousemove', e => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.over = true; }, { passive: true });
container.addEventListener('mouseleave', () => { pointer.over = false; });

function pageAt(x, y) {
  let best = null, bestGap = Infinity;
  for (const div of container.querySelectorAll('.pdfViewer .page')) {
    const r = div.getBoundingClientRect();
    if (r.bottom < y - 4000 || r.top > y + 4000) continue;
    const gap = (y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0) + (x < r.left ? r.left - x : x > r.right ? x - r.right : 0);
    if (gap < bestGap) { bestGap = gap; best = div; }
    if (!gap) break;
  }
  return best;
}
// How the point is held. The document is laid out by the browser: a column of pages inside #viewer, scrolled by
// #viewerContainer. Scrolling alone cannot always put a given point under the pointer - a page narrower than the
// window has no sideways scroll at all, and nothing scrolls above the first page or below the last one. So, for as
// long as it is needed, #viewer gets empty space of its own around the pages (`pad`, in px). With that space the
// wanted position is always reachable and the point never has to give way. The space is trimmed again, invisibly,
// whenever it has been scrolled out of sight, and removed by "fit", 100%, rotation or a window resize.
const pad = { on: false, l: 0, r: 0, t: 0, b: 0 };
let zooming = false, widest = null;
function applyPad(l, r, t, b, width) {
  const st = $('viewer').style;
  pad.on = true;
  pad.l = Math.max(0, Math.round(l)); pad.r = Math.max(0, Math.round(r)); pad.t = Math.max(0, Math.round(t)); pad.b = Math.max(0, Math.round(b));
  st.boxSizing = 'content-box';
  if (width !== undefined) st.width = width + 'px';
  st.paddingLeft = pad.l + 'px'; st.paddingRight = pad.r + 'px'; st.paddingTop = pad.t + 'px'; st.paddingBottom = pad.b + 'px';
}
function resetPad() {
  if (!pad.on) return;
  const st = $('viewer').style;
  st.boxSizing = st.width = st.paddingLeft = st.paddingRight = st.paddingTop = st.paddingBottom = '';
  pad.on = false; pad.l = pad.r = pad.t = pad.b = 0;
}
// Space that is no longer on screen is given back without anything moving.
function healPad() {
  if (!pad.on || zooming || Date.now() < placeQuiet) return;
  let { l, r, t, b } = pad, sl = container.scrollLeft, st = container.scrollTop;
  if (l > 0 && sl >= 1) { const d = Math.min(l, Math.floor(sl)); l -= d; sl -= d; }
  if (t > 0 && st >= 1) { const d = Math.min(t, Math.floor(st)); t -= d; st -= d; }
  const freeX = Math.floor(container.scrollWidth - container.clientWidth - container.scrollLeft);
  const freeY = Math.floor(container.scrollHeight - container.clientHeight - container.scrollTop);
  if (r > 0 && freeX > 0) r -= Math.min(r, freeX);
  if (b > 0 && freeY > 0) b -= Math.min(b, freeY);
  if (l === pad.l && r === pad.r && t === pad.t && b === pad.b) return;
  placeQuiet = Date.now() + 200;
  if (!l && !r && !t && !b && widestWidth() > container.clientWidth) resetPad(); else applyPad(l, r, t, b);
  container.scrollLeft = sl;
  container.scrollTop = st;
}
container.addEventListener('scrollend', healPad);
window.addEventListener('resize', resetPad);
// The widest page, border included, at the current scale (pages of one document can differ in size).
function widestWidth() {
  const pages = viewer._pages || [];
  if (!widest || !widest.div || !widest.div.isConnected) {
    widest = null;
    for (const pv of pages) if (pv && pv.viewport && (!widest || pv.viewport.width > widest.viewport.width)) widest = pv;
  }
  return widest && widest.div ? widest.div.getBoundingClientRect().width : 0;
}

function zoomTo(scale, x, y) {
  if (!pdf) return;
  const old = viewer.currentScale;
  scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(scale * 100) / 100));
  if (!old || scale === old) return;
  const box = container.getBoundingClientRect();
  if (x === undefined) { x = box.left + container.clientWidth / 2; y = box.top + container.clientHeight / 2; }
  // 1. Which point of the document is under the pointer: a page, and a position on its sheet (0..1 each way).
  // One gesture (several notches, or a pinch, with the pointer held still) keeps its first anchor, so rounding
  // in each small step cannot add up to a drift.
  const now = performance.now();
  if (!(hold.page && hold.page.isConnected && hold.x === x && hold.y === y && now - hold.at < 700)) {
    const found = pageAt(x, y);
    hold.page = found;
    hold.x = x;
    hold.y = y;
    if (found) {
      const r = found.getBoundingClientRect(); // the sheet itself, without the page's border (the border does not scale)
      hold.fx = (x - r.left - found.clientLeft) / Math.max(1, found.clientWidth);
      hold.fy = (y - r.top - found.clientTop) / Math.max(1, found.clientHeight);
    }
  }
  hold.at = now;
  const page = hold.page, fx = hold.fx, fy = hold.fy;
  UI.hideToolbar();
  placeQuiet = Date.now() + 400;
  zooming = true;
  try {
    // 2. The new scale. The layout is at its new size as soon as this returns; nothing is painted in between.
    viewer.updateScale({ scaleFactor: scale / old, drawingDelay: 300 });
    if (!page || !page.isConnected) return;
    const view = $('viewer');
    // 3. Sideways: where must the column of pages start so that the point is under the pointer again?
    const width = Math.ceil(widestWidth()) || Math.ceil(page.getBoundingClientRect().width);
    applyPad(0, 0, pad.t, pad.b, width); // a plain column first, to measure where the point sits inside it
    const inColumn = page.getBoundingClientRect().left + page.clientLeft + fx * page.clientWidth - view.getBoundingClientRect().left;
    const left = Math.round(x - inColumn - (box.left + container.clientLeft)); // column start, from the window's left edge
    // to the right of the edge: empty space before it. To the left: scrolled. Either way, never clamped.
    applyPad(Math.max(0, left), Math.max(0, container.clientWidth - left - width - 1), pad.t, pad.b); // 1 px short, so rounding never makes a scrollbar appear
    container.scrollLeft = Math.max(0, -left);
    // 4. Up and down, the same idea: scroll where possible, add space above or below where scrolling has run out.
    const off = page.getBoundingClientRect().top + page.clientTop + fy * page.clientHeight - y; // how far the point is from the pointer now
    let top = container.scrollTop + off, t = pad.t;
    if (top < 0) { t -= top; top = 0; } else if (t > 0) { const d = Math.min(t, Math.floor(top)); t -= d; top -= d; }
    const body = view.offsetHeight - pad.t - pad.b; // the pages alone
    applyPad(pad.l, pad.r, t, Math.max(0, Math.ceil(top + container.clientHeight - t - body)));
    container.scrollTop = top;
    // 5. Final check against what the browser actually did, and a last correction if a rounding slipped in.
    const miss = page.getBoundingClientRect().top + page.clientTop + fy * page.clientHeight - y;
    if (Math.abs(miss) >= 1 && container.scrollTop + miss >= 0) container.scrollTop += miss;
  } finally { zooming = false; }
  clearTimeout(placeTimer);
  placeTimer = setTimeout(savePlace, 1200);
}

// Wheel notches, keys and buttons do not jump to the new size: they glide to it in a few frames, always around
// the same point. More notches while it is still moving simply move the goal.
const glideZoom = { goal: 0, from: 0, start: 0, x: undefined, y: undefined, frame: 0 };
function zoomGlide(goal, x, y) {
  goal = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(goal * 100) / 100));
  if (calm.matches || pdf.numPages > 600) { glideZoom.goal = goal; return zoomTo(goal, x, y); }
  glideZoom.from = viewer.currentScale;
  glideZoom.goal = goal;
  glideZoom.start = performance.now();
  glideZoom.x = x;
  glideZoom.y = y;
  if (!glideZoom.frame) glideZoom.frame = requestAnimationFrame(zoomFrame);
}
function zoomFrame(now) {
  const g = glideZoom, t = Math.min(1, Math.max(0, (now - g.start) / 130)), ease = 1 - Math.pow(1 - t, 3);
  g.frame = 0;
  if (!pdf) return;
  zoomTo(t >= 1 ? g.goal : g.from * Math.pow(g.goal / g.from, ease), g.x, g.y);
  if (t < 1) g.frame = requestAnimationFrame(zoomFrame);
}
// One notch: about 10%, landing on multiples of 5%.
function zoomStep(steps, x, y) {
  let s = glideZoom.frame ? glideZoom.goal : viewer.currentScale;
  for (let i = Math.abs(steps); i > 0; i--) {
    const next = Math.round((steps > 0 ? s * 1.1 : s / 1.1) * 20) / 20; // nearest 5%
    s = steps > 0 ? Math.max(next, s + 0.05) : Math.min(next, s - 0.05);
  }
  zoomGlide(s, x, y);
}
const zoomKey = steps => (pointer.over ? zoomStep(steps, pointer.x, pointer.y) : zoomStep(steps));

// Ctrl + mouse wheel (or a trackpad pinch) zooms the document instead of zooming the browser.
let wheelTicks = 0;
const fine = { scale: 1, at: -1e9 };
window.addEventListener('wheel', e => {
  if (!(e.ctrlKey || e.metaKey) || !pdf) return;
  e.preventDefault();
  if (!e.target.closest || !e.target.closest('#viewerContainer')) return;
  if (e.deltaMode === 0 && Math.abs(e.deltaY) < 40) {
    // fine-grained deltas: trackpad pinch or a smooth-scrolling wheel
    // (the wanted scale is carried between events, so very small movements still add up)
    if (e.timeStamp - fine.at > 300) fine.scale = viewer.currentScale;
    fine.at = e.timeStamp;
    fine.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, fine.scale * Math.exp(Math.max(-0.12, Math.min(0.12, -e.deltaY * 0.01)))));
    if (glideZoom.frame) { cancelAnimationFrame(glideZoom.frame); glideZoom.frame = 0; }
    zoomTo(fine.scale, e.clientX, e.clientY);
    return;
  }
  wheelTicks += e.deltaY < 0 ? 1 : -1;
  const steps = Math.trunc(wheelTicks);
  wheelTicks -= steps;
  if (steps) zoomStep(steps, e.clientX, e.clientY);
}, { passive: false });

$('zoomIn').addEventListener('click', () => zoomStep(1));
$('zoomOut').addEventListener('click', () => zoomStep(-1));
$('zoomPct').addEventListener('click', () => { viewer.currentScaleValue = '1'; });
$('fit').addEventListener('click', () => { viewer.currentScaleValue = viewer.currentScaleValue === 'page-width' ? 'page-fit' : 'page-width'; });
// Rotating keeps your place: the spot in the middle of the window before the turn is in the middle after it.
// (On its own the viewer jumps to the top of the current page.)
function rotateView() {
  if (!pdf) return;
  const box = container.getBoundingClientRect();
  const x = box.left + container.clientWidth / 2, y = box.top + container.clientHeight / 2;
  const page = pageAt(x, y);
  let fx = 0.5, fy = 0.5;
  if (page) {
    const r = page.getBoundingClientRect();
    fx = Math.min(1, Math.max(0, (x - r.left - page.clientLeft) / Math.max(1, page.clientWidth)));
    fy = Math.min(1, Math.max(0, (y - r.top - page.clientTop) / Math.max(1, page.clientHeight)));
  }
  UI.hide();
  placeQuiet = Date.now() + 400;
  viewer.pagesRotation = (viewer.pagesRotation + 90) % 360; // the pages have their new shape when this returns
  if (!page || !page.isConnected) return;
  // a quarter turn clockwise carries the point (fx, fy) of the sheet to (1 - fy, fx)
  const r = page.getBoundingClientRect();
  container.scrollLeft += r.left + page.clientLeft + (1 - fy) * page.clientWidth - x;
  container.scrollTop += r.top + page.clientTop + fx * page.clientHeight - y;
  clearTimeout(placeTimer);
  placeTimer = setTimeout(savePlace, 1200);
}
$('rotate').addEventListener('click', rotateView);
$('dash').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-dashboard' }));
// Small pop-up menu under a toolbar button. items: [{ label, hint, on, swatch, run }]
let openMenu = null;
function closeMenu() {
  if (openMenu) { openMenu.el.remove(); openMenu.anchor.removeAttribute('aria-expanded'); openMenu = null; }
}
function popMenu(anchor, items) {
  const again = openMenu && openMenu.anchor === anchor;
  closeMenu();
  if (again) return;
  const el = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map(it => {
    if (it === '-') return h('div', { class: 'menusep', role: 'separator' });
    let icon = null;
    if (it.icon) { icon = h('span', { class: 'mi-icon' }); icon.innerHTML = '<svg viewBox="0 0 24 24">' + it.icon + '</svg>'; } // fixed markup from this file
    return h('button', { class: 'menuitem' + (it.on ? ' on' : ''), role: 'menuitem', onclick: () => { closeMenu(); it.run(); } },
      icon,
      h('span', { class: 'mi-text' }, h('span', { class: 'mi-label' }, it.label), it.hint ? h('span', { class: 'mi-hint' }, it.hint) : null),
      it.on !== undefined ? h('span', { class: 'mi-check' }, '\u2713') : null);
  }));
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  el.style.top = Math.round(r.bottom + 6) + 'px';
  el.style.right = Math.max(8, Math.round(document.documentElement.clientWidth - r.right)) + 'px';
  anchor.setAttribute('aria-expanded', 'true');
  openMenu = { el, anchor };
}
document.addEventListener('mousedown', e => {
  if (openMenu && !openMenu.el.contains(e.target) && !openMenu.anchor.contains(e.target)) closeMenu();
}, true);

function bytesText(n) {
  if (!n) return '';
  return n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
}
function pdfDate(d) { // "D:20180312101500+07'00'" -> readable
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(String(d || ''));
  if (!m) return '';
  return new Date(Number(m[1]), Number(m[2] || 1) - 1, Number(m[3] || 1), Number(m[4] || 0), Number(m[5] || 0)).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
async function showProperties() {
  const list = $('propsList');
  list.textContent = '';
  let size = 0, dims = '';
  try { size = (await pdf.getDownloadInfo()).length; } catch (e) { /* unknown */ }
  try {
    const vp = (await pdf.getPage(viewer.currentPageNumber || 1)).getViewport({ scale: 1 });
    dims = (vp.width / 72 * 25.4).toFixed(0) + ' x ' + (vp.height / 72 * 25.4).toFixed(0) + ' mm';
  } catch (e) { /* unknown */ }
  const rows = [
    ['Title', doc.title], ['File', doc.fileName || ''], ['Location', sourceUrl], ['Author', pdfInfo.Author], ['Subject', pdfInfo.Subject],
    ['Pages', String(pdf.numPages)], ['Page size', dims], ['File size', bytesText(size)], ['Created', pdfDate(pdfInfo.CreationDate)], ['Modified', pdfDate(pdfInfo.ModDate)],
    ['Produced by', pdfInfo.Producer || pdfInfo.Creator], ['PDF version', pdfInfo.PDFFormatVersion], ['Highlights', String(highlights.length)]
  ];
  for (const [k, v] of rows) if (v) list.append(h('dt', null, k), h('dd', null, String(v)));
  $('propsDialog').showModal();
}

// The three-dot menu: document, appearance, Margin. Light and dark leave the document exactly as it is;
// night also darkens the page; device follows the computer's own light or dark setting.
const ICONS = {
  device: '<circle cx="12" cy="12" r="8.5"/><path d="M9 16l3-8 3 8M10.2 13.2h3.6"/>',
  light: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/>',
  dark: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none"/>',
  night: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>'
};
$('more').addEventListener('click', e => {
  const cur = globalThis.MarginTheme.get();
  const mode = (id, label) => ({ label, icon: ICONS[id], on: cur === id, run: () => globalThis.MarginTheme.set(id) });
  popMenu(e.currentTarget, [
    pdf ? { label: 'Document properties', run: showProperties } : null,
    sourceUrl ? { label: 'Open in browser viewer', run: () => chrome.runtime.sendMessage({ type: 'open-native', url: sourceUrl }) } : null,
    { label: 'Open a PDF from this computer', run: () => $('file').click() },
    '-',
    mode('device', 'Device mode'), mode('light', 'Light mode'), mode('dark', 'Dark mode'), mode('night', 'Night mode'),
    '-',
    { label: 'Margin settings', run: () => chrome.runtime.sendMessage({ type: 'open-dashboard', hash: 'settings' }) },
    { label: 'Library and vocabulary', run: () => chrome.runtime.sendMessage({ type: 'open-dashboard', hash: 'library' }) },
    '-',
    { label: 'Margin ' + chrome.runtime.getManifest().version, hint: 'The version running in this browser', run: () => {} }
  ]);
});

async function find(again, previous) {
  const query = $('find').value;
  if (pdf && ocrLang() !== 'off' && (await isScannedDoc())) return ocrFind(query, again, previous);
  eventBus.dispatch('find', {
    source: window, type: again ? 'again' : '', query, caseSensitive: false, entireWord: false,
    highlightAll: true, findPrevious: !!previous, matchDiacritics: false
  });
  if (!query) $('findCount').textContent = '';
}
function toggleFind(open) {
  $('findBar').hidden = !open;
  $('findBtn').setAttribute('aria-pressed', String(open));
  if (open) {
    $('find').focus();
    $('find').select();
  } else {
    $('find').value = '';
    find(false);
    container.focus();
  }
}
$('findBtn').addEventListener('click', () => toggleFind($('findBar').hidden));
$('findClose').addEventListener('click', () => toggleFind(false));
$('findNext').addEventListener('click', () => find(true, false));
$('findPrev').addEventListener('click', () => find(true, true));
$('find').addEventListener('input', () => find(false));
$('find').addEventListener('keydown', e => {
  if (e.key === 'Enter') find(true, e.shiftKey);
  else if (e.key === 'Escape') toggleFind(false);
});
const showCount = e => {
  if (ofind.scannedDoc) return; // scanned documents report their own count
  const m = e.matchesCount || {};
  $('findCount').textContent = $('find').value ? (m.total ? m.current + ' / ' + m.total : 'No results') : '';
};
eventBus.on('updatefindmatchescount', showCount);
eventBus.on('updatefindcontrolstate', showCount);

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && pdf) {
    e.preventDefault();
    toggleFind(true);
  } else if ((e.ctrlKey || e.metaKey) && pdf && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_' || e.key === '0')) {
    // Ctrl and + / - / 0 zoom the document, like the wheel
    e.preventDefault();
    if (e.key === '0') viewer.currentScaleValue = '1';
    else if (e.key === '-' || e.key === '_') zoomKey(-1);
    else zoomKey(1);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && draw.on && !/INPUT|TEXTAREA/.test(e.target.tagName)) {
    e.preventDefault();
    undoInk();
  } else if (e.key === 'Escape') {
    closeMenu();
    if (draw.on && !UI.isOpen()) setDrawing(false);
    UI.hide();
  }
});

// drag and drop
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) openFile(f);
});

// ------------------------------------------------------------------ start
async function renderRecent() {
  const docs = (await Store.listDocs()).filter(d => d.type === 'pdf').slice(0, 8);
  const box = $('recent');
  box.textContent = '';
  if (!docs.length) return;
  box.appendChild(h('h2', null, 'Recently annotated'));
  for (const d of docs) {
    if (d.url) box.appendChild(h('a', { href: '#', onclick: e => { e.preventDefault(); chrome.runtime.sendMessage({ type: 'open-pdf', url: d.url }); } }, d.title));
    else box.appendChild(h('div', { class: 'local', title: 'Local file - open it again from your computer and its highlights will reappear' }, d.title + ' (local file)'));
  }
}

if (['hl', 'outline', 'thumbs', 'cite'].includes(settings.readerPanel)) openPanel(settings.readerPanel, false); else closePanel(false);
// Movement starts only after the first layout, so opening a document never shows things sliding into place.
setTimeout(() => document.body.classList.add('anim'), 300);

// Sync (if a folder was chosen in Settings) keeps running while the reader is open.
globalThis.MarginSync.start(() => globalThis.MarginSync.pill('Sync paused - open Settings to reconnect', () => chrome.runtime.sendMessage({ type: 'open-dashboard', hash: 'settings' })));

if (fileParam) openDocument({ url: fileParam }, nameFromUrl(fileParam));
else renderRecent();
