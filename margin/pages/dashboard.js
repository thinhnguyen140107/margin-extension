// Margin - dashboard: library of highlights, vocabulary list, flashcard review, notes, settings.
(async function () {
  'use strict';
  const Store = MarginStore, UI = MarginUI, h = UI.h;
  const $ = id => document.getElementById(id);
  const READER = chrome.runtime.getURL('reader/reader.html');
  const PRIVACY_NOTE = 'Your highlights, notes and words stay in this browser - Margin has no account and no server. ' +
    'Text leaves your computer only when you ask for it: the words you choose to translate go to Google Translate ' +
    '(MyMemory as a fallback) and a dictionary service, and opening the Cite panel sends the document\'s title or DOI to Crossref. ' +
    'Scanned pages are read on your own computer.';
  const fmtDate = t => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  // The language picker shown on the welcome screen.
  function firstLang() {
    const el = h('select', { class: 'field', 'aria-label': 'Translate into' }, Store.LANGS.map(([v, l]) => h('option', { value: v }, l)));
    Store.getSettings().then(st => { el.value = st.targetLang; });
    el.addEventListener('change', () => Store.setSettings({ targetLang: el.value }));
    return el;
  }

  function relDue(due) {
    const d = due - Date.now();
    if (d <= 0) return 'Due now';
    if (d < 3600000) return 'in ' + Math.max(1, Math.round(d / 60000)) + ' min';
    if (d < Store.DAY) return 'in ' + Math.round(d / 3600000) + ' h';
    return 'in ' + Math.round(d / Store.DAY) + ' d';
  }
  function ctxNode(sentence, term, cls) {
    const i = sentence.toLowerCase().indexOf(term.toLowerCase());
    if (i < 0) return h('div', { class: cls }, sentence);
    return h('div', { class: cls }, sentence.slice(0, i), h('b', null, sentence.slice(i, i + term.length)), sentence.slice(i + term.length));
  }
  // ------------------------------------------------------------ navigation
  const views = ['library', 'vocab', 'review', 'notes', 'settings'];
  let view = 'library';
  function show(name) {
    if (!views.includes(name)) name = 'library';
    view = name;
    views.forEach(v => { $(v).hidden = v !== name; });
    document.querySelectorAll('.navbtn').forEach(b => b.classList.toggle('on', b.dataset.view === name));
    if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
    render();
  }
  document.querySelectorAll('.navbtn').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
  $('openReader').addEventListener('click', () => { location.href = READER; });

  async function render() {
    updateBadge();
    if (view === 'library') await renderLibrary();
    else if (view === 'vocab') await renderVocab();
    else if (view === 'review') await startReview(false);
    else if (view === 'notes') await renderNotes();
    else if (view === 'settings') await renderSettings();
  }
  async function updateBadge() {
    const n = (await Store.dueVocab()).length;
    $('dueBadge').hidden = !n;
    $('dueBadge').textContent = n;
  }

  // ------------------------------------------------------------ library
  let selected = null; // { kind: 'doc' | 'cat', id }
  let Cite = null;
  let cites = {}; // docId -> saved citation details (for printed page numbers)
  const pageOf = (doc, hl) => { const f = cites[doc.id] && cites[doc.id].meta && Number(cites[doc.id].meta.firstPage); return f ? f + hl.page - 1 : hl.page; };
  import('../reader/cite.js').then(m => { Cite = m; if (view === 'library') renderLibrary(); }).catch(() => {});
  // PDFs open through the background worker so they land on their own URL with the reader mounted.
  const openLink = (doc, label, cls) => {
    const url = Store.safeUrl(doc.url); // stored addresses are only followed when they are web or local-file ones
    if (!url) return null;
    if (doc.type !== 'pdf') return h('a', { class: cls, href: url, target: '_blank', rel: 'noopener noreferrer' }, label);
    return h('a', { class: cls, href: '#', onclick: e => { e.preventDefault(); chrome.runtime.sendMessage({ type: 'open-pdf', url }); } }, label);
  };

  function highlightRow(doc, hl, rerender, pal) {
    const vocab = hl.kind === 'vocab';
    const hex = vocab ? '#2f8f76' : Store.colorOf(pal, hl.color).hex;
    const body = h('div', { class: 'body' }, h('div', { class: 'text' + (hl.text ? '' : ' muted') }, hl.text || 'Hand-drawn mark'));
    const noteBox = h('div');
    const drawNote = () => {
      noteBox.textContent = '';
      if (hl.note) noteBox.appendChild(h('div', { class: 'note' }, hl.note));
    };
    drawNote();
    const edit = () => {
      noteBox.textContent = '';
      const ta = h('textarea', { placeholder: 'Add a note...' });
      ta.value = hl.note || '';
      ta.addEventListener('blur', async () => {
        hl.note = ta.value.trim();
        await Store.updateHighlight(doc.id, hl.id, { note: hl.note });
        drawNote();
      });
      noteBox.appendChild(ta);
      ta.focus();
    };
    body.appendChild(noteBox);
    body.appendChild(h('div', { class: 'meta' },
      h('span', null, (hl.page ? 'p. ' + pageOf(doc, hl) + ' \u00b7 ' : '') + (vocab ? 'Saved word · ' : '') + fmtDate(hl.createdAt)),
      h('button', { class: 'link', onclick: edit }, hl.note ? 'Edit note' : 'Add note'),
      h('button', { class: 'link danger', onclick: async () => { await Store.removeHighlight(doc.id, hl.id); rerender(); } }, 'Delete')
    ));
    return h('div', { class: 'hl' + (vocab ? ' vocab' : ''), style: '--c:' + hex }, body);
  }

  const byPosition = (a, b) => ((a.page || 0) - (b.page || 0)) || (a.createdAt - b.createdAt);

  const groupHead = (hex, name, count, vocab) => h('div', { class: 'ghead' },
    h('span', { class: 'gdot' + (vocab ? ' vocab' : ''), style: vocab ? '' : 'background:' + hex }), h('span', { class: 'gname' }, name), h('span', { class: 'gcount' }, String(count)));

  // Appends a document's highlights grouped by what each color means.
  function appendGrouped(box, d, items, pal) {
    for (const c of pal) {
      const group = items.filter(x => x.kind !== 'vocab' && x.color === c.id);
      if (!group.length) continue;
      box.appendChild(groupHead(c.hex, c.name + (c.scope === 'doc' ? '  (this document only)' : ''), group.length));
      group.forEach(x => box.appendChild(highlightRow(d, x, renderLibrary, pal)));
    }
    const words = items.filter(x => x.kind === 'vocab');
    if (words.length) {
      box.appendChild(groupHead('', 'Saved words', words.length, true));
      words.forEach(x => box.appendChild(highlightRow(d, x, renderLibrary, pal)));
    }
  }

  // One drawing at a time: a second request while one is running is done right after it, never on top of it
  // (two at once would each add their rows and everything would appear twice).
  let libRunning = false, libAgain = false;
  async function renderLibrary() {
    if (libRunning) { libAgain = true; return; }
    libRunning = true;
    try {
      do { libAgain = false; await drawLibrary(); } while (libAgain);
    } finally { libRunning = false; }
  }
  async function drawLibrary() {
    const docs = await Store.listDocs();
    const settings = await Store.getSettings();
    const query = $('libSearch').value.trim().toLowerCase();
    const list = $('docList'), detail = $('docDetail');
    list.textContent = '';
    detail.textContent = '';

    const all = {}, pals = {};
    const stored = await chrome.storage.local.get(docs.map(d => 'cite:' + d.id));
    cites = {};
    for (const d of docs) if (stored['cite:' + d.id]) cites[d.id] = stored['cite:' + d.id];
    for (const d of docs) {
      all[d.id] = await Store.getHighlights(d.id);
      pals[d.id] = Store.paletteFor(settings, d, all[d.id]);
    }

    if (!docs.length) {
      list.appendChild(h('div', { class: 'empty' }, 'No documents yet.'));
      detail.appendChild(h('div', { class: 'welcome' },
        h('h2', null, 'Welcome to Margin'),
        h('ol', null,
          h('li', null, 'Open any PDF in this browser - a web link, or a file dragged into a tab. It opens in the Margin reader.'),
          h('li', null, 'Select text to highlight it, add a note, or translate just that word. Save words you want to learn.'),
          h('li', null, 'Scanned pages are read automatically; the pen in the toolbar marks anything by hand.'),
          h('li', null, 'Come back here for your library, vocabulary flashcards, notes export and settings.')),
        h('p', null, 'For PDFs stored on your computer, switch on "Allow access to file URLs" for Margin: ',
          h('button', { class: 'btn small', onclick: () => chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id }) }, 'Open extension details')),
        h('p', null, 'Translate words into ', firstLang(), ' (change it any time in Settings).'),
        h('p', { class: 'muted' }, PRIVACY_NOTE)));
      detail.appendChild(h('div', { class: 'empty' }, 'Your highlights will be collected here, by document and by what each color means.',
        h('div', { style: 'margin-top:14px' }, 'Had highlights here before? Open Settings and import the newest file from Downloads/Margin backups.')));
      return;
    }

    if (query) {
      let total = 0;
      for (const d of docs) {
        const hits = all[d.id].filter(x => (x.text + ' ' + (x.note || '')).toLowerCase().includes(query)).sort(byPosition);
        if (!hits.length) continue;
        total += hits.length;
        detail.appendChild(h('div', { class: 'group' }, d.title));
        hits.forEach(x => detail.appendChild(highlightRow(d, x, renderLibrary, pals[d.id])));
      }
      if (!total) detail.appendChild(h('div', { class: 'empty' }, 'Nothing matches "' + query + '".'));
    }

    const cats = Store.globalPalette(settings);
    if (!selected || (selected.kind === 'doc' && !docs.some(d => d.id === selected.id)) || (selected.kind === 'cat' && !cats.some(c => c.id === selected.id))) {
      selected = { kind: 'doc', id: docs[0].id };
    }
    const pick = sel => { selected = sel; $('libSearch').value = ''; renderLibrary(); };
    const isOn = (kind, id) => !query && selected.kind === kind && selected.id === id;

    // Level 1: the four main categories, across every document.
    list.appendChild(h('div', { class: 'listhead' }, 'Categories'));
    for (const c of cats) {
      const n = docs.reduce((sum, d) => sum + all[d.id].filter(x => x.kind !== 'vocab' && x.color === c.id).length, 0);
      list.appendChild(h('button', { class: 'row cat' + (isOn('cat', c.id) ? ' on' : ''), onclick: () => pick({ kind: 'cat', id: c.id }) },
        h('span', { class: 'gdot', style: 'background:' + c.hex }), h('span', { class: 't' }, c.name), h('span', { class: 'gcount' }, String(n))));
    }
    // Level 2: documents, each with its own breakdown by color.
    list.appendChild(h('div', { class: 'listhead' }, 'Documents'));
    for (const d of docs) {
      const items = all[d.id];
      const notes = items.filter(x => x.note).length;
      const used = pals[d.id].filter(c => items.some(x => x.kind !== 'vocab' && x.color === c.id));
      list.appendChild(h('button', { class: 'row' + (isOn('doc', d.id) ? ' on' : ''), onclick: () => pick({ kind: 'doc', id: d.id }) },
        h('div', { class: 't' }, h('span', { class: 'pill' }, d.type === 'pdf' ? 'PDF' : 'WEB'), d.title),
        h('div', { class: 's' }, used.map(c => h('span', { class: 'mini', style: 'background:' + c.hex, title: c.name })),
          items.length + ' highlight' + (items.length === 1 ? '' : 's') + (notes ? ' · ' + notes + ' note' + (notes === 1 ? '' : 's') : '') + ' · ' + fmtDate(d.updatedAt))
      ));
    }
    if (query) return;

    if (selected.kind === 'cat') {
      const c = cats.find(x => x.id === selected.id);
      detail.appendChild(h('div', { class: 'dochead' }, h('div', { class: 'info' },
        h('h2', null, h('span', { class: 'gdot big', style: 'background:' + c.hex }), c.name),
        h('div', { class: 'url' }, 'Everything marked with this color, across all documents. Rename it in Settings or in the reader sidebar.'))));
      let total = 0;
      for (const d of docs) {
        const items = all[d.id].filter(x => x.kind !== 'vocab' && x.color === c.id).sort(byPosition);
        if (!items.length) continue;
        total += items.length;
        detail.appendChild(h('div', { class: 'ghead doc' }, h('span', { class: 'gname' }, d.title), openLink(d, 'Open', 'link'), h('span', { class: 'gcount' }, String(items.length))));
        items.forEach(x => detail.appendChild(highlightRow(d, x, renderLibrary, pals[d.id])));
      }
      if (!total) detail.appendChild(h('div', { class: 'empty' }, 'Nothing is marked "' + c.name + '" yet.'));
      return;
    }

    const d = docs.find(x => x.id === selected.id);
    const items = all[d.id].slice().sort(byPosition);
    detail.appendChild(h('div', { class: 'dochead' },
      h('div', { class: 'info' },
        h('h2', null, d.title),
        h('div', { class: 'url' }, d.url || 'Local file' + (d.fileName ? ': ' + d.fileName : '') + ' - reopen it in the reader to see these highlights on the page')),
      MarginExport.menu(async () => {
        const cite = cites[d.id];
        const style = Cite && Cite.STYLES.some(x => x[0] === settings.citeStyle) ? settings.citeStyle : 'apa';
        return {
          title: d.title, source: d.url || '', highlights: items, palette: pals[d.id], pageOf: hl => pageOf(d, hl), vocab: await Store.listVocab(),
          citation: Cite && cite && cite.meta && cite.source !== 'pdf' ? Cite.formatCitation(cite.meta, style) : null
        };
      }, msg => UI.toast(msg)),
      openLink(d, 'Open', 'btn'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (confirm('Remove "' + d.title + '" and its ' + items.length + ' highlights from your library?')) { await Store.removeDoc(d.id); renderLibrary(); }
      } }, 'Remove')
    ));
    const saved = cites[d.id];
    if (Cite && saved && saved.meta && saved.source !== 'pdf') {
      const style = Cite.STYLES.some(x => x[0] === settings.citeStyle) ? settings.citeStyle : 'apa';
      const out = Cite.formatCitation(saved.meta, style);
      const box = h('div', { class: 'citeline' });
      Cite.renderCitation(box, out.html);
      detail.appendChild(h('div', { class: 'citewrap' }, box,
        h('button', { class: 'btn small', onclick: async () => {
          try {
            await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([out.html], { type: 'text/html' }), 'text/plain': new Blob([out.text], { type: 'text/plain' }) })]);
          } catch (e) { await navigator.clipboard.writeText(out.text); }
          UI.toast('Citation copied');
        } }, 'Copy citation')));
    }
    if (!items.length) detail.appendChild(h('div', { class: 'empty' }, 'No highlights left in this document.'));
    appendGrouped(detail, d, items, pals[d.id]);
  }
  $('libSearch').addEventListener('input', renderLibrary);

  // ------------------------------------------------------------ vocabulary
  async function renderVocab() {
    const all = await Store.listVocab();
    const now = Date.now();
    const due = all.filter(v => v.srs.due <= now).length;
    const mature = all.filter(v => v.srs.interval >= 21).length;
    const stats = $('vocabStats');
    stats.textContent = '';
    [['Words', all.length], ['Due', due], ['Learned', mature]].forEach(([label, n]) =>
      stats.appendChild(h('div', { class: 'stat' }, h('b', null, String(n)), h('span', null, label))));

    const q = $('vocabSearch').value.trim().toLowerCase();
    const sort = $('vocabSort').value;
    let list = all.filter(v => !q || (v.term + ' ' + v.translation + ' ' + ((v.defs || [])[0] || {}).definition).toLowerCase().includes(q));
    const defFirst = (await Store.getSettings()).cardMode !== 'translation';
    if (sort === 'due') list.sort((a, b) => a.srs.due - b.srs.due);
    else if (sort === 'az') list.sort((a, b) => a.term.localeCompare(b.term));

    const box = $('vocabList');
    box.textContent = '';
    if (!list.length) {
      box.appendChild(h('div', { class: 'empty' }, all.length ? 'No words match your search.' : 'No words yet. Select a word while reading, choose Translate, then Save to vocabulary.'));
      return;
    }
    for (const v of list) {
      const tr = h('div', { class: 'tr', title: 'Click to edit' }, v.translation || '(add a translation)');
      tr.addEventListener('click', () => {
        if (tr.querySelector('input')) return;
        const input = h('input', { class: 'field' });
        input.value = v.translation || '';
        tr.textContent = '';
        tr.appendChild(input);
        input.focus();
        const done = async () => {
          v.translation = input.value.trim();
          await Store.updateVocab(v.id, { translation: v.translation });
          tr.textContent = v.translation || '(add a translation)';
        };
        input.addEventListener('blur', done);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
      });
      const ctx = (v.contexts || [])[v.contexts.length - 1];
      const srcLink = ctx && ctx.docTitle ? openLink({ url: ctx.url, type: ctx.docId && ctx.docId.startsWith('pdf-') ? 'pdf' : 'web' }, ctx.docTitle, 'src') : null;
      box.appendChild(h('div', { class: 'word' },
        h('div', null,
          h('div', { class: 'term' }, v.term),
          h('div', { class: 'ph' }, v.phonetic || '', ' ', h('button', { class: 'link', onclick: e => UI.listen(e.currentTarget, v.term, v.lang) }, 'Listen'))),
        // the meaning: the definition leads (unless translations were chosen in Settings), the translation sits under it
        defFirst && v.defs && v.defs[0]
          ? h('div', { class: 'meaning' },
            h('div', { class: 'def1' }, v.defs[0].pos ? h('span', { class: 'pos' }, v.defs[0].pos + ' ') : null, v.defs[0].definition), tr)
          : h('div', null, tr,
            (v.alts || []).slice(0, 2).map(a => h('div', { class: 'alt' }, (a.pos && a.pos !== 'other' ? a.pos + ': ' : '') + a.terms.slice(0, 4).join(', ')))),
        h('div', null,
          ctx ? ctxNode(ctx.sentence, v.term, 'ctx') : (!defFirst && v.defs && v.defs[0] ? h('div', { class: 'ctx' }, v.defs[0].definition) : null),
          ctx && ctx.docTitle ? (srcLink || h('span', { class: 'src muted' }, ctx.docTitle)) : null),
        h('div', { class: 'side' },
          h('div', null, relDue(v.srs.due)),
          h('button', { class: 'link danger', onclick: async () => { await Store.removeVocab(v.id); renderVocab(); updateBadge(); } }, 'Delete'))
      ));
    }
  }
  // A plain text file in the layout Anki's "Import File" understands: one word per line, three fields
  // (word, meaning, example), with the header lines that tell Anki how to read it.
  $('ankiExport').addEventListener('click', async () => {
    const all = await Store.listVocab();
    if (!all.length) return UI.toast('No words to export yet.');
    const esc = t => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\t\r\n]+/g, ' ').trim();
    const lines = ['#separator:tab', '#html:true', '#notetype:Basic', '#deck:Margin', '#columns:Front\tBack'];
    for (const v of all) {
      const ctx = (v.contexts || [])[(v.contexts || []).length - 1];
      const defs = (v.defs || []).slice(0, 2).map(d => (d.pos ? '<i>' + esc(d.pos) + '</i> ' : '') + esc(d.definition));
      const back = defs.concat(v.translation ? ['<span style="color:#777">' + esc(v.translation) + '</span>'] : []).join('<br>');
      const front = '<b>' + esc(v.term) + '</b>' + (v.phonetic ? ' <span style="color:#777">' + esc(v.phonetic) + '</span>' : '') +
        (ctx && ctx.sentence ? '<br><br><i>' + esc(ctx.sentence) + '</i>' : '');
      if (back) lines.push(front + '\t' + back);
    }
    MarginExport.download(new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }), 'margin-words-for-anki.txt');
    UI.toast((lines.length - 5) + ' words saved. In Anki: File > Import, choose this file.');
  });
  $('vocabSearch').addEventListener('input', renderVocab);
  $('vocabSort').addEventListener('change', renderVocab);

  // ------------------------------------------------------------ review
  // Three ways to study the same cards (one schedule per word, whichever way you answer):
  //   recognize - see the word, recall its meaning        recall - see the meaning, recall the word
  //   type      - see the meaning, type the word
  const MODES = [['recognize', 'Word → meaning'], ['recall', 'Meaning → word'], ['type', 'Type the word']];
  let queue = [], qi = 0, revealed = false, practice = false, mode = 'recognize', typed = null, defFirstReview = true, bothReview = false, showTr = false;

  const norm = t => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');
  function distance(a, b) { // edit distance, to tell a typo from a wrong answer
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[b.length];
  }
  // The example sentence with the word hidden, for the modes where the word is the answer.
  function blanked(sentence, term) {
    const i = sentence.toLowerCase().indexOf(term.toLowerCase());
    return i < 0 ? '' : sentence.slice(0, i) + '_____' + sentence.slice(i + term.length);
  }

  async function startReview(all) {
    const settings = await Store.getSettings();
    mode = MODES.some(m => m[0] === settings.reviewMode) ? settings.reviewMode : 'recognize';
    practice = !!all;
    queue = all ? (await Store.listVocab()).sort(() => Math.random() - 0.5) : await Store.dueVocab();
    defFirstReview = settings.cardMode !== 'translation';
    bothReview = settings.cardMode === 'both';
    if (mode !== 'recognize') queue = queue.filter(v => v.translation || (v.defs || []).length); // nothing to prompt with otherwise
    qi = 0;
    revealed = false;
    typed = null;
    drawReview();
  }

  function modeBar() {
    return h('div', { class: 'modes', role: 'tablist' }, MODES.map(([id, label]) =>
      h('button', { class: 'gseg' + (id === mode ? ' on' : ''), onclick: async () => { await Store.setSettings({ reviewMode: id }); startReview(practice); } }, label)));
  }

  async function drawReview() {
    const box = $('reviewBox');
    box.textContent = '';
    box.appendChild(modeBar());
    if (qi >= queue.length) {
      const all = await Store.listVocab();
      const next = all.length ? Math.min(...all.map(v => v.srs.due)) : 0;
      const stillDue = (await Store.dueVocab()).length;
      box.appendChild(h('div', { class: 'card' },
        h('div', { class: 'term long' }, !all.length ? 'No words to review yet' : queue.length ? 'Session complete' : 'Nothing is due right now'),
        h('div', { class: 'ctx' }, !all.length
          ? 'Save words with Translate while you read, and they will show up here on a spaced schedule.'
          : stillDue ? stillDue + ' card' + (stillDue === 1 ? ' is' : 's are') + ' due again shortly.' : 'Next review ' + relDue(next) + '.'),
        all.length ? h('div', { class: 'actions' },
          stillDue ? h('button', { class: 'btn pri', onclick: () => startReview(false) }, 'Continue') : null,
          h('button', { class: 'btn', onclick: () => startReview(true) }, 'Practice all ' + all.length + ' words')) : null
      ));
      updateBadge();
      return;
    }
    const v = queue[qi];
    const ctx = (v.contexts || [])[(v.contexts || []).length - 1];
    const long = v.term.length > 40;
    const wordSide = [
      h('div', { class: 'term' + (long ? ' long' : '') }, v.term),
      h('div', { class: 'ph' }, v.phonetic || '', ' ', h('button', { class: 'link', onclick: e => UI.listen(e.currentTarget, v.term, v.lang) }, 'Listen')),
      ctx ? ctxNode(ctx.sentence, v.term, 'ctx') : null
    ];
    // The meaning. With definitions leading (the default) the card shows the definition, and the translation
    // stays behind a click so that the answer has to be understood, not just recognized.
    const defs = (v.defs || []).slice(0, 2);
    const trLines = [
      h('div', { class: 'tr' + (defFirstReview && defs.length ? ' small' : '') }, v.translation || '(no translation saved)'),
      (v.alts || []).slice(0, 3).map(a => h('div', { class: 'alt' }, (a.pos && a.pos !== 'other' ? a.pos + ': ' : '') + a.terms.slice(0, 4).join(', ')))
    ];
    const meaningSide = defFirstReview && defs.length
      ? [defs.map(d => h('div', { class: 'def lead' }, d.pos ? h('span', { class: 'pos' }, d.pos + ' ') : null, d.definition)),
        v.translation ? (bothReview || showTr ? trLines
          : h('button', { class: 'link more', onclick: e => { e.stopPropagation(); showTr = true; drawReview(); } }, 'Show translation')) : null]
      : [trLines, mode === 'recognize' ? defs.map(d => h('div', { class: 'def' }, (d.pos ? d.pos + ' · ' : '') + d.definition)) : null];
    const hint = ctx && blanked(ctx.sentence, v.term);
    const front = mode === 'recognize' ? wordSide : [meaningSide, hint ? h('div', { class: 'ctx' }, hint) : null];
    const back = mode === 'recognize' ? meaningSide : wordSide;

    const card = h('div', { class: 'card' }, front);
    box.appendChild(h('div', { class: 'progress' },
      h('span', null, (practice ? 'Practice · ' : '') + (qi + 1) + ' of ' + queue.length), h('span', { class: 'grow' }),
      ctx && ctx.docTitle ? h('span', null, ctx.docTitle) : null));
    box.appendChild(card);

    if (!revealed) {
      if (mode === 'type') {
        const input = h('input', { class: 'field answerbox', type: 'text', placeholder: 'Type the word, then press Enter', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Your answer' });
        const check = () => {
          const d = distance(norm(input.value), norm(v.term));
          typed = { text: input.value.trim(), result: d === 0 ? 'right' : d <= Math.max(1, Math.floor(v.term.length / 6)) && input.value.trim() ? 'close' : 'wrong' };
          revealed = true;
          drawReview();
        };
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); check(); } });
        box.appendChild(h('div', { class: 'actions' }, input, h('button', { class: 'btn pri', onclick: check }, 'Check')));
        setTimeout(() => input.focus(), 0);
      } else {
        box.appendChild(h('div', { class: 'actions' }, h('button', { class: 'btn pri', onclick: () => { revealed = true; drawReview(); } }, 'Show answer')));
        box.appendChild(h('div', { class: 'kbd' }, 'Space to reveal'));
      }
      return;
    }
    let suggest = -1;
    if (mode === 'type' && typed) {
      suggest = typed.result === 'right' ? 2 : typed.result === 'close' ? 1 : 0;
      card.appendChild(h('div', { class: 'verdict ' + typed.result },
        typed.result === 'right' ? 'Correct' : typed.result === 'close' ? 'Almost - you typed "' + typed.text + '"' : typed.text ? 'Not quite - you typed "' + typed.text + '"' : 'No answer'));
    }
    card.appendChild(h('div', { class: 'answer' }, back));
    const labels = ['Again', 'Hard', 'Good', 'Easy'];
    box.appendChild(h('div', { class: 'grades' }, labels.map((label, g) =>
      h('button', { class: 'btn' + (g === suggest ? ' suggested' : ''), onclick: () => grade(g) }, label, h('small', null, Store.describeInterval(v.srs, g))))));
    box.appendChild(h('div', { class: 'kbd' }, suggest >= 0 ? 'Enter to accept "' + labels[suggest] + '", or keys 1 to 4' : 'Keys 1 to 4 to grade'));
  }

  async function grade(g) {
    const v = queue[qi];
    if (!v || !revealed) return;
    v.srs = Store.schedule(v.srs, g);
    await Store.updateVocab(v.id, { srs: v.srs });
    qi++;
    revealed = false;
    typed = null;
    showTr = false;
    drawReview();
  }

  document.addEventListener('keydown', e => {
    if (view !== 'review' || qi >= queue.length || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (!revealed && mode !== 'type' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); revealed = true; drawReview(); }
    else if (revealed && /^[1-4]$/.test(e.key)) grade(Number(e.key) - 1);
    else if (revealed && e.key === 'Enter' && typed) { e.preventDefault(); grade(typed.result === 'right' ? 2 : typed.result === 'close' ? 1 : 0); }
  });

  // ------------------------------------------------------------ notes
  let selectedNote = null;
  async function renderNotes() {
    const notes = await Store.listNotes();
    const list = $('noteList'), detail = $('noteDetail');
    list.textContent = '';
    if (selectedNote && !notes.some(n => n.id === selectedNote)) selectedNote = null;
    if (!selectedNote && notes.length) selectedNote = notes[0].id;
    for (const n of notes) {
      list.appendChild(h('button', { class: 'row' + (n.id === selectedNote ? ' on' : ''), 'data-id': n.id, onclick: () => { selectedNote = n.id; renderNotes(); } },
        h('div', { class: 't' }, n.title || 'Untitled note'),
        h('div', { class: 's' }, fmtDate(n.updatedAt) + (n.body ? ' · ' + n.body.replace(/\s+/g, ' ').slice(0, 60) : ''))));
    }
    detail.textContent = '';
    const note = notes.find(n => n.id === selectedNote);
    if (!note) {
      detail.appendChild(h('div', { class: 'empty' }, 'Free-form notes that are not tied to a highlight live here. Create one to get started.'));
      return;
    }
    const title = h('input', { class: 'noteTitle', placeholder: 'Title' });
    const body = h('textarea', { class: 'noteBody', placeholder: 'Write your note...' });
    const status = h('span', null, 'Saved ' + fmtDate(note.updatedAt));
    title.value = note.title;
    body.value = note.body;
    let timer = null;
    const save = async () => {
      note.title = title.value;
      note.body = body.value;
      await Store.saveNote(note);
      status.textContent = 'Saved';
      const row = list.querySelector('[data-id="' + note.id + '"] .t');
      if (row) row.textContent = note.title || 'Untitled note';
    };
    const queueSave = () => { status.textContent = 'Saving...'; clearTimeout(timer); timer = setTimeout(save, 400); };
    title.addEventListener('input', queueSave);
    body.addEventListener('input', queueSave);
    detail.appendChild(title);
    detail.appendChild(body);
    detail.appendChild(h('div', { class: 'noteFoot' }, status, h('span', { class: 'grow' }),
      Store.safeUrl(note.sourceUrl) ? h('a', { href: Store.safeUrl(note.sourceUrl), target: '_blank', rel: 'noopener noreferrer' }, 'Source page') : null,
      h('button', { class: 'link danger', onclick: async () => {
        if (confirm('Delete this note?')) { clearTimeout(timer); await Store.removeNote(note.id); selectedNote = null; renderNotes(); }
      } }, 'Delete note')));
  }
  $('newNote').addEventListener('click', async () => {
    const n = await Store.saveNote({ title: '', body: '' });
    selectedNote = n.id;
    await renderNotes();
    const t = document.querySelector('.noteTitle');
    if (t) t.focus();
  });

  // ------------------------------------------------------------ settings
  const LANGS = Store.LANGS;

  async function renderSettings() {
    const s = await Store.getSettings();
    const box = $('settingsBox');
    box.textContent = '';
    const set = patch => Store.setSettings(patch);
    const row = (label, hint, control) => h('div', { class: 'setting' }, h('div', { class: 'lbl' }, label, hint ? h('small', null, hint) : null), control);
    const check = key => {
      const c = h('input', { type: 'checkbox' });
      c.checked = !!s[key];
      c.addEventListener('change', () => set({ [key]: c.checked }));
      return c;
    };
    const select = key => {
      const el = h('select', { class: 'field' }, LANGS.map(([v, l]) => h('option', { value: v }, l)));
      el.value = s[key];
      el.addEventListener('change', () => set({ [key]: el.value }));
      return el;
    };
    const pal = Store.globalPalette(s);
    const swatches = h('div', { class: 'swatches' });
    pal.forEach(c => {
      const b = h('button', { style: 'background:' + c.hex, class: c.id === s.defaultColor ? 'on' : '', title: c.name, 'aria-label': c.name });
      b.addEventListener('click', async () => { await set({ defaultColor: c.id }); renderSettings(); });
      swatches.appendChild(b);
    });
    const colorRows = pal.map(c => {
      const hex = h('input', { type: 'color', class: 'colorpick', value: c.hex, 'aria-label': 'Color' });
      const name = h('input', { type: 'text', class: 'field colorname', maxlength: '40', 'aria-label': 'What this color is for' });
      name.value = c.name;
      hex.addEventListener('change', () => Store.saveGlobalColor(c.id, { hex: hex.value }));
      name.addEventListener('change', () => { if (name.value.trim()) Store.saveGlobalColor(c.id, { name: name.value.trim() }); });
      return h('div', { class: 'setting' }, hex, name);
    });

    const look = h('select', { class: 'field' }, [['device', 'Device mode'], ['light', 'Light mode'], ['dark', 'Dark mode'], ['night', 'Night mode']].map(([v, l]) => h('option', { value: v }, l)));
    look.value = MarginTheme.get();
    look.addEventListener('change', () => MarginTheme.set(look.value));
    box.appendChild(h('h3', { style: 'margin-top:0' }, 'Appearance'));
    const moves = h('select', { class: 'field' }, [['system', 'Same as this computer'], ['on', 'Always on'], ['off', 'Off']].map(([v, l]) => h('option', { value: v }, l)));
    moves.value = MarginTheme.motion();
    moves.addEventListener('change', () => MarginTheme.setMotion(moves.value));
    box.appendChild(h('div', { class: 'box' },
      row('Theme', 'Device follows your computer. Light and Dark never change a document\'s own colors; Night also darkens the page in the reader.', look),
      row('Animations', 'Gliding zoom, the sliding side panel and soft fades. ' + (MarginTheme.systemCalm() ? 'This computer is set to show fewer animations, so "Same as this computer" means none - choose "Always on" to have them in Margin.' : 'This computer allows animations.'), moves)));

    box.appendChild(h('h3', null, 'Translation'));
    box.appendChild(h('div', { class: 'box' },
      row('A word card shows first', 'The definition makes you think in the language you are reading; the translation is then one click away. Where no definition exists (phrases, names, texts that are not in English) the translation is shown.',
        (() => {
          const el = h('select', { class: 'field' }, [['definition', 'The definition'], ['both', 'Definition and translation'], ['translation', 'The translation']].map(([v, l]) => h('option', { value: v }, l)));
          el.value = ['both', 'translation'].includes(s.cardMode) ? s.cardMode : 'definition';
          el.addEventListener('change', () => set({ cardMode: el.value }));
          return el;
        })()),
      row('Translate into', 'The language translations are shown in.', select('targetLang')),
      row('I mostly read in', 'Used for dictionary definitions and as the fallback source language.', select('sourceLang')),
      row('Mark saved words in the text', 'Saved words get a dashed underline where you found them.', check('markSavedWords'))));

    box.appendChild(h('h3', null, 'Highlight colors'));
    box.appendChild(h('div', { class: 'box' }, colorRows));
    box.appendChild(h('div', { class: 'hintline' }, 'These four colors and their names apply to every document, for both text highlights and the pen. Extra colors are added inside a document and stay with it.'));

    box.appendChild(h('h3', null, 'Reading'));
    const fileRow = h('div', { class: 'setting' });
    chrome.extension.isAllowedFileSchemeAccess(ok => {
      fileRow.appendChild(h('div', { class: 'lbl' }, 'Local PDF files',
        h('small', null, ok ? 'PDFs opened from your computer go straight to the reader.'
          : 'Turn on "Allow access to file URLs" in the extension details to open local PDFs automatically. Drag-and-drop into the reader works either way.')));
      if (!ok) fileRow.appendChild(h('button', { class: 'btn', onclick: () => chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id }) }, 'Open extension details'));
    });
    const ocrSel = h('select', { class: 'field' }, [['eng', 'English'], ['vie', 'Vietnamese'], ['eng+vie', 'English + Vietnamese'], ['off', 'Off']].map(([v, l]) => h('option', { value: v }, l)));
    ocrSel.value = s.ocr || 'eng';
    ocrSel.addEventListener('change', () => set({ ocr: ocrSel.value }));
    box.appendChild(h('div', { class: 'box' },
      row('Read the text on scanned pages', 'Pages that are only an image are read on your computer so you can select, highlight and translate them. Pick the language the documents are written in.', ocrSel)));
    box.appendChild(h('div', { style: 'height:12px' }));
    box.appendChild(h('div', { class: 'box' },
      row('Open PDFs in the Margin reader', 'PDFs open in the reader on their own address, so you can highlight them.', check('autoOpenPdf')),
      fileRow,
      row('Use Margin on web pages too', 'Off: Margin works in PDFs only. On: selecting text on any page shows the toolbar, and your highlights there are kept. Single sites can be switched off from the toolbar icon.', check('webHighlights')),
      row('Default highlight color', 'Used by Note and by the right-click menu.', swatches)));

    if (s.disabledHosts.length) {
      box.appendChild(h('h3', null, 'Sites where the toolbar is off'));
      box.appendChild(h('div', { class: 'box' }, s.disabledHosts.map(host =>
        row(host, '', h('button', { class: 'btn small', onclick: async () => { await set({ disabledHosts: s.disabledHosts.filter(x => x !== host) }); renderSettings(); } }, 'Turn on')))));
    }

    box.appendChild(h('h3', null, 'Keyboard in the reader'));
    box.appendChild(h('div', { class: 'box' },
      row('With text selected', '1, 2, 3, 4: highlight in that color.  T: look the word up.  N: add a note.', null),
      row('Anywhere', 'Ctrl + scroll or Ctrl + plus / minus: zoom at the pointer.  Ctrl + 0: 100%.  Ctrl + F: search.  Esc: close.', null)));

    box.appendChild(h('h3', null, 'Sync between your computers'));
    const sy = await MarginSync.status();
    const syncBox = h('div', { class: 'box' });
    const resync = async interactive => {
      const r = await MarginSync.run({ interactive });
      UI.toast(r.ok ? (r.pulled || r.pushed ? 'Synced' : 'Already up to date') : r.reason === 'permission' ? 'The browser needs your permission for that folder again' : 'Sync failed: ' + r.reason);
      renderSettings();
    };
    if (!sy.supported) {
      syncBox.appendChild(row('Not available in this browser yet',
        'Sync needs the browser\'s folder access feature. In Brave it is switched off by default: open brave://flags/#file-system-access-api, set it to Enabled, relaunch, then come back here. Chrome and Edge have it on.', null));
    } else if (!sy.connected) {
      syncBox.appendChild(row('Choose a sync folder',
        'Pick (or create) a folder inside OneDrive, Google Drive or Dropbox. Margin keeps one file there and merges it with this computer. Do the same on your other computer and pick the same folder.',
        h('button', { class: 'btn', onclick: async () => {
          try { const r = await MarginSync.choose(); UI.toast(r.ok ? 'Sync is on' : 'Sync failed: ' + r.reason); } catch (e) { if (e.name !== 'AbortError') UI.toast('Could not use that folder: ' + e.message); }
          renderSettings();
        } }, 'Choose folder')));
    } else {
      syncBox.appendChild(row('Syncing with the folder "' + sy.folder + '"',
        (sy.paused ? 'Paused: the browser wants you to confirm access to the folder again.' : sy.at ? 'Last synced ' + new Date(sy.at).toLocaleString() + '.' : 'Not synced yet.') + (sy.error ? ' Last problem: ' + sy.error : '') +
          ' Runs whenever a Margin page is open.',
        h('span', { class: 'btnrow' },
          h('button', { class: 'btn', onclick: () => resync(true) }, sy.paused ? 'Reconnect' : 'Sync now'),
          h('button', { class: 'btn', onclick: async () => { await MarginSync.disconnect(); renderSettings(); } }, 'Stop'))));
    }
    box.appendChild(syncBox);

    box.appendChild(h('h3', null, 'Privacy'));
    box.appendChild(h('div', { class: 'box' }, h('div', { class: 'setting' }, h('div', { class: 'lbl' }, PRIVACY_NOTE))));

    box.appendChild(h('h3', null, 'Backup'));
    const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      if (!f) return;
      try {
        await Store.importAll(JSON.parse(await f.text()), false);
        UI.toast('Backup imported');
        renderSettings();
      } catch (e) {
        UI.toast('Import failed: ' + e.message);
      }
      fileInput.value = '';
    });
    const st = (await chrome.storage.local.get('_backup'))._backup || {};
    const freq = h('select', { class: 'field' }, [['daily', 'Once a day'], ['often', 'Every 2 hours'], ['off', 'Off']].map(([v, l]) => h('option', { value: v }, l)));
    freq.value = s.backup || 'daily';
    freq.addEventListener('change', () => set({ backup: freq.value }));
    const status = st.at
      ? 'Last saved ' + new Date(st.at).toLocaleString() + ' to your Downloads folder: ' + st.file + '.'
      : 'No automatic backup yet. The first one is written a few minutes after you start highlighting.';
    box.appendChild(h('div', { class: 'box' },
      row('Automatic backup', status + ' Only when something changed. One file per weekday, so you always have a week of copies.', freq),
      row('Back up now', st.error && (!st.at || st.errorAt > st.at) ? 'The last attempt failed: ' + st.error : 'Writes a copy immediately.',
        h('button', { class: 'btn', onclick: async () => {
          const r = await chrome.runtime.sendMessage({ type: 'backup-now' });
          UI.toast(r && r.ok ? 'Backup saved to Downloads/' + r.file : r && r.reason === 'empty' ? 'Nothing to back up yet' : 'Backup failed: ' + (r && r.reason));
          renderSettings();
        } }, 'Back up now'))));
    box.appendChild(h('div', { class: 'hintline' }, 'To restore after reinstalling or moving the extension: Import a backup below and pick the newest file in Downloads/Margin backups.'));
    box.appendChild(h('div', { class: 'box', style: 'margin-top:12px' },
      row('Export everything', 'Highlights, notes, vocabulary and settings as one JSON file. Your data is stored only in this browser, so export before reinstalling.',
        h('button', { class: 'btn', onclick: async () => {
          const blob = new Blob([JSON.stringify(await Store.exportAll(), null, 2)], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: 'margin-backup-' + new Date().toISOString().slice(0, 10) + '.json' });
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        } }, 'Export')),
      row('Import a backup', 'Merges the file into what is already here.', h('span', null, fileInput, h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Import')))));
  }

  // ------------------------------------------------------------ live sync + start
  let syncTimer = null;
  chrome.storage.onChanged.addListener(changes => {
    const keys = Object.keys(changes);
    updateBadge();
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      const editing = document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
      if (editing) return;
      if (view === 'library' && keys.some(k => k.startsWith('hl:') || k.startsWith('doc:') || k === 'settings')) renderLibrary();
      else if (view === 'vocab' && keys.some(k => k.startsWith('voc:'))) renderVocab();
    }, 300);
  });
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  show(location.hash.slice(1) || 'library');
  MarginSync.start(() => MarginSync.pill('Sync paused - click to reconnect', async () => {
    const r = await MarginSync.run({ interactive: true });
    UI.toast(r.ok ? 'Sync is back on' : 'Sync is still paused');
  }));
})();
