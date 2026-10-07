// Margin - highlighting, notes and on-demand translation on ordinary web pages.
(async function () {
  'use strict';
  if (window.top !== window || window.__marginLoaded) return;
  if (document.contentType === 'application/pdf') return; // handled by content/pdf.js
  window.__marginLoaded = true;

  const Store = MarginStore, UI = MarginUI;
  const TAG = 'margin-mark';
  const SKIP = 'script,style,noscript,textarea,select,option,margin-ui,svg,head';

  let settings = await Store.getSettings();
  let url = Store.normalizeUrl(location.href);
  let docId = Store.webDocId(url);
  let highlights = [];
  let docRecord = null; // library entry for this page; holds the colors that belong to this page only
  const palette = () => Store.paletteFor(settings, docRecord, highlights);
  const restyle = () => highlights.forEach(hl => marksOf(hl.id).forEach(m => applyAttrs(m, hl)));

  const docInfo = () => ({ id: docId, type: 'web', title: document.title || location.hostname, url });
  // Off by default: Margin then does nothing at all on ordinary pages (no toolbar, no marks, no menu items).
  const enabled = () => !!settings.webHighlights && !settings.disabledHosts.includes(location.hostname);
  let wasOn = enabled();
  // On a web page the panel is sealed off from the page's own scripts, so a site cannot read your notes or
  // press Margin's buttons. (settings.debugUi is a testing switch that only an extension page can set.)
  UI.setPrivate(!settings.debugUi);

  chrome.storage.onChanged.addListener(changes => {
    if (changes.settings) {
      settings = Object.assign({}, Store.DEFAULTS, changes.settings.newValue || {});
      if (enabled() !== wasOn) {
        wasOn = enabled();
        if (wasOn) load(); else { UI.hide(); document.querySelectorAll(TAG).forEach(unwrapEl); }
      } else restyle();
    }
    if (changes['doc:' + docId]) { docRecord = changes['doc:' + docId].newValue || null; restyle(); }
    // Highlights changed elsewhere (e.g. deleted from the dashboard): re-sync this page.
    const key = 'hl:' + docId;
    if (changes[key] && !selfWrite) {
      highlights = changes[key].newValue || [];
      document.querySelectorAll(TAG).forEach(unwrapEl);
      restoreAll();
    }
  });
  let selfWrite = false;
  async function own(promise) {
    selfWrite = true;
    try { return await promise; } finally { setTimeout(() => { selfWrite = false; }, 50); }
  }

  // ------------------------------------------------------------ styles
  // Added to a page only once Margin is actually used on it.
  let styled = false;
  function ensureStyle() {
    if (styled) return;
    styled = true;
  const style = document.createElement('style');
  style.textContent =
    TAG + '{background-color:var(--margin-c,#fbe08a)!important;color:#1a1a1a!important;border-radius:2px;cursor:pointer;display:inline!important;' +
    'box-decoration-break:clone;-webkit-box-decoration-break:clone;}' +
    TAG + '[data-note]{box-shadow:inset 0 -2px 0 rgba(0,0,0,.55);}' +
    TAG + '[data-kind="vocab"]{background-color:transparent!important;color:inherit!important;border-bottom:2px dashed #2f8f76;border-radius:0;}';
  (document.head || document.documentElement).appendChild(style);
  }

  // ------------------------------------------------------------ text model
  function textNodes(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        return !p || p.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function buildIndex() {
    const nodes = textNodes(document.body);
    const starts = new Array(nodes.length);
    let text = '';
    for (let i = 0; i < nodes.length; i++) {
      starts[i] = text.length;
      text += nodes[i].data;
    }
    return { nodes, starts, text };
  }

  // Turns a [a, b) span of the page text into per-node segments.
  function segmentsFor(index, a, b) {
    const segs = [];
    for (let i = 0; i < index.nodes.length; i++) {
      const s = index.starts[i], e = s + index.nodes[i].data.length;
      if (e <= a) continue;
      if (s >= b) break;
      segs.push({ node: index.nodes[i], start: Math.max(a, s) - s, end: Math.min(b, e) - s });
    }
    return segs;
  }

  function applyAttrs(el, hl) {
    el.dataset.marginId = hl.id;
    el.dataset.kind = hl.kind || 'highlight';
    el.style.setProperty('--margin-c', Store.tint(Store.colorOf(palette(), hl.color).hex, 0.55));
    if (hl.note) el.dataset.note = '1'; else delete el.dataset.note;
  }

  function wrap(segs, hl) {
    for (const seg of segs) {
      let n = seg.node;
      if (!n.data.slice(seg.start, seg.end).trim()) continue; // never wrap bare whitespace (breaks tables/lists)
      if (seg.end < n.data.length) n.splitText(seg.end);
      if (seg.start > 0) n = n.splitText(seg.start);
      const el = document.createElement(TAG);
      applyAttrs(el, hl);
      n.parentNode.insertBefore(el, n);
      el.appendChild(n);
    }
  }

  function unwrapEl(el) {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize();
  }
  const marksOf = id => document.querySelectorAll(TAG + '[data-margin-id="' + id + '"]');

  function locate(index, hl) {
    const { text } = index;
    let best = -1, bestScore = -1, from = 0, i;
    while ((i = text.indexOf(hl.quote, from)) !== -1) {
      let score = 0;
      const pre = text.slice(Math.max(0, i - hl.prefix.length), i);
      const suf = text.slice(i + hl.quote.length, i + hl.quote.length + hl.suffix.length);
      for (let k = 1; k <= Math.min(pre.length, hl.prefix.length); k++) {
        if (pre[pre.length - k] === hl.prefix[hl.prefix.length - k]) score++; else break;
      }
      for (let k = 0; k < Math.min(suf.length, hl.suffix.length); k++) {
        if (suf[k] === hl.suffix[k]) score++; else break;
      }
      if (score > bestScore) { bestScore = score; best = i; }
      from = i + 1;
    }
    return best;
  }

  function restoreAll() {
    if (!document.body) return 0;
    let missing = 0;
    for (const hl of highlights) {
      if (!hl.quote || marksOf(hl.id).length) continue;
      const index = buildIndex();
      const at = locate(index, hl);
      if (at < 0) { missing++; continue; }
      wrap(segmentsFor(index, at, at + hl.quote.length), hl);
    }
    return missing;
  }

  async function load() {
    url = Store.normalizeUrl(location.href);
    docId = Store.webDocId(url);
    highlights = await Store.getHighlights(docId);
    docRecord = (await Store.getDoc(docId)) || null;
    if (!enabled()) return;
    ensureStyle();
    if (!highlights.length) return;
    // Pages that render late (single-page apps) get a few more attempts.
    let tries = 0;
    const attempt = () => {
      const missing = restoreAll();
      if (missing && ++tries < 4) setTimeout(attempt, 1500 * tries);
    };
    attempt();
  }
  await load();
  setInterval(() => {
    if (enabled() && Store.normalizeUrl(location.href) !== url) {
      document.querySelectorAll(TAG).forEach(unwrapEl);
      load();
    }
  }, 1000);

  // ------------------------------------------------------------ creating highlights
  async function createFromRange(range, props) {
    const index = buildIndex();
    let a = -1, b = -1;
    for (let i = 0; i < index.nodes.length; i++) {
      const n = index.nodes[i];
      if (!range.intersectsNode(n)) continue;
      const s = n === range.startContainer ? range.startOffset : 0;
      const e = n === range.endContainer ? range.endOffset : n.data.length;
      if (e <= s) continue;
      if (a < 0) a = index.starts[i] + s;
      b = index.starts[i] + e;
    }
    if (a < 0 || b <= a) return null;
    const quote = index.text.slice(a, b);
    if (!quote.trim()) return null;
    const hl = await own(Store.addHighlight(docInfo(), Object.assign({
      color: settings.defaultColor,
      text: quote.replace(/\s+/g, ' ').trim(),
      quote,
      prefix: index.text.slice(Math.max(0, a - 32), a),
      suffix: index.text.slice(b, b + 32)
    }, props)));
    highlights.push(hl);
    wrap(segmentsFor(index, a, b), hl);
    return hl;
  }

  function contextFor(range, text) {
    let el = range.commonAncestorContainer;
    if (el.nodeType !== 1) el = el.parentElement;
    while (el && el !== document.body && getComputedStyle(el).display.startsWith('inline')) el = el.parentElement;
    if (!el) return '';
    const block = (el.innerText || el.textContent || '').replace(/[ \t ]+/g, ' ');
    const needle = text.replace(/\s+/g, ' ');
    const i = block.indexOf(needle);
    if (i < 0 || block.length > 20000) return '';
    return UI.sentenceAround(block, i, i + needle.length);
  }

  function rectOf(range) {
    const r = range.getBoundingClientRect();
    if (r.width || r.height) return r;
    return range.getClientRects()[0] || r;
  }

  function currentSelection() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString().trim();
    if (!text || text.length > 6000) return null;
    const range = sel.getRangeAt(0);
    let el = range.commonAncestorContainer;
    if (el.nodeType !== 1) el = el.parentElement;
    if (!el || el.closest('input,textarea,[contenteditable=""],[contenteditable="true"],margin-ui') || el.isContentEditable) return null;
    return { sel, range: range.cloneRange(), text };
  }

  function translate(range, text, rect) {
    UI.showCard(rect, { text, context: contextFor(range, text), source: { docId, docTitle: document.title, url } }, {
      async onSaved() {
        if (!settings.markSavedWords || text.length > 80) return;
        try { await createFromRange(range, { kind: 'vocab' }); } catch (e) { /* page changed */ }
        getSelection().removeAllRanges();
      }
    });
  }

  function openEditor(hl, rect, opts) {
    UI.showEditor(rect, hl, {
      async onColor(c) {
        hl.color = c;
        hl.kind = 'highlight';
        marksOf(hl.id).forEach(m => applyAttrs(m, hl));
        await own(Store.updateHighlight(docId, hl.id, { color: c, kind: 'highlight' }));
      },
      async onNote(note) {
        hl.note = note;
        marksOf(hl.id).forEach(m => applyAttrs(m, hl));
        await own(Store.updateHighlight(docId, hl.id, { note }));
      },
      async onDelete() {
        marksOf(hl.id).forEach(unwrapEl);
        highlights = highlights.filter(x => x.id !== hl.id);
        await own(Store.removeHighlight(docId, hl.id));
      },
      onTranslate() {
        const first = marksOf(hl.id)[0];
        const range = document.createRange();
        if (first) range.selectNodeContents(first);
        UI.showCard(rect, { text: hl.text, context: first ? contextFor(range, hl.text) : '', source: { docId, docTitle: document.title, url } });
      }
    }, Object.assign({ palette: palette() }, opts));
  }

  function showToolbarForSelection() {
    const cur = currentSelection();
    if (!cur) return;
    const rect = rectOf(cur.range);
    UI.showToolbar(rect, {
      async onColor(color) {
        await createFromRange(cur.range, { color });
        getSelection().removeAllRanges();
      },
      async onNote() {
        const hl = await createFromRange(cur.range, {});
        getSelection().removeAllRanges();
        if (hl) openEditor(hl, rect, { focusNote: true });
      },
      onTranslate() { translate(cur.range, cur.text, rect); },
      async onAddColor(info) {
        const c = await Store.saveDocColor(docInfo(), info);
        docRecord = await Store.getDoc(docId);
        return c;
      }
    }, palette());
  }

  // ------------------------------------------------------------ events
  document.addEventListener('mouseup', e => {
    if (UI.isOwn(e.target) || !enabled()) return;
    setTimeout(showToolbarForSelection, 0);
  });
  document.addEventListener('mousedown', e => {
    if (!UI.isOwn(e.target)) UI.hide();
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') UI.hide();
  }, true);
  window.addEventListener('scroll', () => UI.hideToolbar(), { passive: true, capture: true });

  document.addEventListener('click', e => {
    const el = e.target && e.target.closest ? e.target.closest(TAG) : null;
    if (!el || !getSelection().isCollapsed) return;
    const hl = highlights.find(x => x.id === el.dataset.marginId);
    if (hl) openEditor(hl, el.getBoundingClientRect());
  });

  chrome.runtime.onMessage.addListener(msg => {
    const cur = enabled() && currentSelection();
    if (!cur) return;
    if (msg.type === 'ctx-translate') translate(cur.range, cur.text, rectOf(cur.range));
    else if (msg.type === 'ctx-highlight') createFromRange(cur.range, {}).then(() => getSelection().removeAllRanges());
  });
})();
