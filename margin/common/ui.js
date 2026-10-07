// Margin - shared floating UI (selection toolbar, translation card, highlight editor).
// Rendered inside a shadow root so page styles cannot leak in or out.
// Used by both the web-page content script and the PDF reader.
(function (g) {
  'use strict';
  if (g.MarginUI) return;
  const Store = g.MarginStore;

  const CSS = `
    :host { all: initial; }
    .layer { --bg:#ffffff; --fg:#202124; --muted:#5f6368; --bd:#dadce0; --soft:#f1f3f4; --accent:#1a73e8; --accent-fg:#ffffff; --danger:#b3261e;
      font: 13px/1.45 Roboto, "Segoe UI", system-ui, -apple-system, Arial, sans-serif; color: var(--fg); text-align: left; }
    @media (prefers-color-scheme: dark) {
      .layer { --bg:#292a2d; --fg:#e8eaed; --muted:#9aa0a6; --bd:#3c4043; --soft:#35363a; --accent:#8ab4f8; --accent-fg:#202124; --danger:#ff8a80; }
    }
    :host([data-ui="dark"]) .layer { --bg:#292a2d; --fg:#e8eaed; --muted:#9aa0a6; --bd:#3c4043; --soft:#35363a; --accent:#8ab4f8; --accent-fg:#202124; --danger:#ff8a80; }
    :host([data-ui="light"]) .layer { --bg:#ffffff; --fg:#202124; --muted:#5f6368; --bd:#dadce0; --soft:#f1f3f4; --accent:#1a73e8; --accent-fg:#ffffff; --danger:#b3261e; }
    * { box-sizing: border-box; }
    button { font: inherit; cursor: pointer; }
    .tb { position: fixed; display: flex; align-items: center; gap: 2px; padding: 5px 7px; background: #202124; color: #fff;
      border-radius: 6px; box-shadow: 0 6px 24px rgba(0,0,0,.28); white-space: nowrap; user-select: none; animation: pop .12s cubic-bezier(.2,0,0,1); }
    .dot { width: 18px; height: 18px; padding: 0; margin: 0 2px; border-radius: 50%; border: 2px solid rgba(255,255,255,.15); transition: transform .08s; }
    .dot:hover { transform: scale(1.18); }
    .dot.on { border-color: var(--fg); }
    .tb .dot { position: relative; }
    .tb .dot:hover::after { content: attr(data-name); position: absolute; left: 50%; bottom: calc(100% + 9px); transform: translateX(-50%);
      background: #1f2328; color: #fff; font-size: 11px; font-weight: 500; padding: 3px 8px; border-radius: 6px; white-space: nowrap; pointer-events: none;
      box-shadow: 0 2px 10px rgba(0,0,0,.3); }
    .plus { width: 20px; height: 20px; padding: 0; margin: 0 2px; border-radius: 50%; border: 1.5px dashed rgba(255,255,255,.55); background: none; color: #fff;
      font-size: 14px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; }
    .plus:hover { border-style: solid; background: rgba(255,255,255,.14); }
    .cname { margin-left: 8px; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cardtitle { font-weight: 650; margin-bottom: 10px; }
    .inp { flex: 1; min-width: 0; height: 32px; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--bd); border-radius: 8px; padding: 0 9px; outline: none; }
    .inp:focus { border-color: var(--accent); }
    .swatch { flex: none; width: 34px; height: 32px; padding: 0; margin-right: 8px; border: 1px solid var(--bd); border-radius: 8px; background: none; cursor: pointer; }
    .tb .t { background: none; border: 0; color: #fff; padding: 4px 8px; border-radius: 6px; font-weight: 500; }
    .tb .t:hover { background: rgba(255,255,255,.14); }
    .sep { width: 1px; height: 16px; background: rgba(255,255,255,.25); margin: 0 4px; }
    .card { position: fixed; width: 330px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow: auto; background: var(--bg); color: var(--fg);
      border: 1px solid var(--bd); border-radius: 8px; box-shadow: 0 10px 36px rgba(0,0,0,.22); padding: 12px 14px; animation: pop .14s cubic-bezier(.2,0,0,1); }
    .head { display: flex; align-items: baseline; gap: 8px; }
    .term { font-size: 16px; font-weight: 650; overflow-wrap: anywhere; }
    .term.long { font-size: 13px; font-weight: 500; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .ph { color: var(--muted); font-size: 12px; }
    .grow { flex: 1; }
    .icon { background: none; border: 0; color: var(--muted); padding: 2px 5px; border-radius: 6px; line-height: 1; font-size: 14px; }
    .icon:hover { background: var(--soft); color: var(--fg); }
    .icon.on { color: var(--accent); }
    .icon.bad { opacity: .45; }
    .tr { font-size: 17px; font-weight: 600; color: var(--accent); margin: 8px 0 4px; overflow-wrap: anywhere; }
    .tr.long { font-size: 14px; font-weight: 500; }
    .alts { margin: 4px 0; }
    .alts div, .defs div { margin: 3px 0; }
    .pos { display: inline-block; font-size: 11px; color: var(--muted); font-style: italic; margin-right: 6px; }
    .defs { border-top: 1px solid var(--bd); margin-top: 8px; padding-top: 6px; }
    .defs.lead { border-top: 0; margin-top: 6px; padding-top: 0; font-size: 14px; line-height: 1.5; }
    .defs.lead > div { margin: 6px 0; }
    .form { color: var(--muted); font-size: 12px; font-style: italic; }
    .under { border-top: 1px solid var(--bd); margin-top: 8px; padding-top: 2px; }
    .more { background: none; border: 0; padding: 4px 0; margin-top: 4px; color: var(--accent); font: inherit; font-size: 12px; }
    .more:hover { text-decoration: underline; }
    [hidden] { display: none !important; }
    .ex { color: var(--muted); font-style: italic; }
    .ctx { margin-top: 8px; padding: 6px 8px; background: var(--soft); border-radius: 8px; color: var(--muted); font-size: 12px; }
    .ctx b { color: var(--fg); }
    .foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
    .prov { color: var(--muted); font-size: 11px; }
    .btn { border: 1px solid var(--bd); background: var(--bg); color: var(--fg); padding: 5px 10px; border-radius: 8px; font-weight: 500; }
    .btn:hover { background: var(--soft); }
    .btn.pri { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
    .btn.pri:hover { filter: brightness(1.08); background: var(--accent); }
    .btn.pri[disabled] { opacity: .65; cursor: default; }
    .btn.danger { color: var(--danger); }
    .muted { color: var(--muted); }
    .err { color: var(--danger); margin: 8px 0 2px; }
    .quote { border-left: 3px solid var(--bd); padding-left: 8px; color: var(--muted); margin-bottom: 8px;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .row { display: flex; align-items: center; gap: 2px; margin-bottom: 8px; }
    textarea { width: 100%; min-height: 76px; resize: vertical; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--bd);
      border-radius: 8px; padding: 7px 8px; outline: none; }
    textarea:focus { border-color: var(--accent); }
    .toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); background: #1f2328; color: #fff; padding: 8px 14px; border-radius: 8px;
      box-shadow: 0 6px 24px rgba(0,0,0,.28); animation: rise .18s cubic-bezier(.2,0,0,1); transition: opacity .2s ease; }
    .toast.out { opacity: 0; }
    .defs, .alts { animation: fade .18s ease; }
    .btn, .icon, .tb .t { transition: background-color .12s ease, color .12s ease; }
    .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--bd); border-top-color: var(--accent); border-radius: 50%;
      animation: sp .7s linear infinite; vertical-align: -2px; margin-right: 6px; }
    @keyframes sp { to { transform: rotate(360deg); } }
    @keyframes pop { from { opacity: 0; translate: 0 4px; } }
    @keyframes rise { from { opacity: 0; translate: 0 8px; } }
    @keyframes fade { from { opacity: 0; } }
    :host([data-motion="off"]) * { animation: none !important; transition: none !important; }
  `;

  let host = null, layer = null;
  let toolbarEl = null, cardEl = null, toastTimer = null;

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return el;
  }

  let sealed = false; // see setPrivate
  function setPrivate(on) { sealed = !!on; }
  function ensure() {
    if (host && host.isConnected) return;
    host = document.createElement('margin-ui');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    if (document.documentElement.dataset.ui) host.dataset.ui = document.documentElement.dataset.ui; // Margin pages only
    // motion: Margin's own pages decide in theme.js; on other pages follow the computer
    host.dataset.motion = document.documentElement.dataset.motion || (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : 'on');
    const root = host.attachShadow({ mode: sealed ? 'closed' : 'open' });
    root.appendChild(h('style', null, CSS));
    layer = h('div', { class: 'layer' });
    root.appendChild(layer);
    // Keep the page from reacting to typing/clicking inside our UI, and keep the text selection alive.
    for (const t of ['keydown', 'keyup', 'keypress', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'contextmenu']) {
      host.addEventListener(t, e => e.stopPropagation());
    }
    host.addEventListener('mousedown', e => {
      e.stopPropagation();
      const t = e.composedPath()[0];
      if (!(t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT'))) e.preventDefault();
    });
    document.documentElement.appendChild(host);
    toolbarEl = cardEl = null;
  }

  function place(el, rect, prefer) {
    const w = el.offsetWidth, ht = el.offsetHeight, m = 8;
    const vw = document.documentElement.clientWidth || innerWidth, vh = innerHeight;
    let x = rect.left + rect.width / 2 - w / 2;
    x = Math.max(m, Math.min(x, vw - w - m));
    let y;
    if (prefer === 'above') {
      y = rect.top - ht - m;
      if (y < m) y = rect.bottom + m;
    } else {
      y = rect.bottom + m;
      if (y + ht > vh - m) y = rect.top - ht - m;
    }
    y = Math.max(m, Math.min(y, vh - ht - m));
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
  }

  function hideToolbar() {
    if (toolbarEl) { toolbarEl.remove(); toolbarEl = null; }
  }
  function hideCard() {
    if (cardEl) {
      const fn = cardEl._onClose;
      cardEl.remove();
      cardEl = null;
      if (fn) fn();
    }
  }
  function hide() { hideToolbar(); hideCard(); }
  function isOpen() { return !!(toolbarEl || cardEl); }

  // palette: [{ id, hex, name }]
  function dots(palette, selected, onPick) {
    return palette.map(c =>
      h('button', {
        class: 'dot' + (c.id === selected ? ' on' : ''), style: 'background:' + c.hex, title: c.name, 'data-name': c.name,
        'aria-label': c.name, onclick: () => onPick(c.id)
      })
    );
  }

  // Small form for a new color that belongs to the current document only. onSave({ name, hex })
  function showColorForm(rect, onSave) {
    ensure();
    hide();
    const name = h('input', { class: 'inp', type: 'text', placeholder: 'What is this color for?', maxlength: '40' });
    const hex = h('input', { class: 'swatch', type: 'color', value: '#8a63f5', 'aria-label': 'Color' });
    const save = () => {
      const label = name.value.trim();
      if (!label) { name.focus(); return; }
      cardEl = null;
      card.remove();
      onSave({ name: label, hex: hex.value });
    };
    name.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    const card = h('div', { class: 'card', role: 'dialog', 'aria-label': 'New color' },
      h('div', { class: 'cardtitle' }, 'New color for this document'),
      h('div', { class: 'row' }, hex, name),
      h('div', { class: 'foot' }, h('span', { class: 'grow' }),
        h('button', { class: 'btn', onclick: hideCard }, 'Cancel'),
        h('button', { class: 'btn pri', onclick: save }, 'Add'))
    );
    cardEl = card;
    layer.appendChild(card);
    place(card, rect, 'below');
    setTimeout(() => name.focus(), 0);
  }

  // handlers: { onColor(id), onNote(), onTranslate(), onAddColor({ name, hex }) -> color (optional) }
  function showToolbar(rect, handlers, palette) {
    ensure();
    hide();
    palette = palette || Store.globalPalette(null);
    toolbarEl = h('div', { class: 'tb', role: 'toolbar' },
      dots(palette, null, c => { hideToolbar(); handlers.onColor(c); }),
      handlers.onAddColor ? h('button', {
        class: 'plus', title: 'New color for this document', 'aria-label': 'New color for this document',
        onclick: () => showColorForm(rect, async info => { const c = await handlers.onAddColor(info); if (c) handlers.onColor(c.id); })
      }, '+') : null,
      h('span', { class: 'sep' }),
      h('button', { class: 't', title: 'Highlight and add a note', onclick: () => { hideToolbar(); handlers.onNote(); } }, 'Note'),
      h('button', { class: 't', title: 'Translate the selected text', onclick: () => { hideToolbar(); handlers.onTranslate(); } }, 'Translate')
    );
    layer.appendChild(toolbarEl);
    place(toolbarEl, rect, 'above');
  }

  // Reading aloud uses the voices installed on this computer. The voice is chosen here rather than left to the
  // browser: handed a language it has no voice for (a short English word is easily taken for French), a browser
  // may say nothing at all. done(error) is called once, with no argument when the word was spoken.
  let saying = null; // the utterance in progress; kept so it is not discarded before it has been spoken
  function voiceFor(synth, lang) {
    let list = [];
    try { list = synth.getVoices() || []; } catch (e) { /* none */ }
    if (!list.length) return null;
    const code = v => String(v.lang || '').toLowerCase().replace('_', '-');
    const want = String(lang).toLowerCase().replace('_', '-'), base = want.split('-')[0];
    const same = list.filter(v => code(v).split('-')[0] === base);
    return same.find(v => code(v) === want) || same.find(v => v.default) || same.find(v => v.localService) || same[0] ||
      list.find(v => v.default) || list[0];
  }
  function speak(text, lang, done) {
    lang = lang && lang !== 'auto' ? lang : 'en';
    let finished = false;
    const end = err => { if (finished) return; finished = true; clearTimeout(watch); if (done) done(err); };
    let watch = 0, synth = null;
    try { synth = g.speechSynthesis; } catch (e) { /* blocked */ }
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') { end('unavailable'); return; }
    const go = () => {
      if (finished) return;
      try {
        const u = new SpeechSynthesisUtterance(text);
        const v = voiceFor(synth, lang);
        if (v) { u.voice = v; u.lang = v.lang; } else u.lang = lang;
        u.onstart = () => clearTimeout(watch);
        u.onend = () => { if (saying === u) saying = null; end(); };
        u.onerror = e => { if (saying === u) saying = null; end(e && (e.error === 'interrupted' || e.error === 'canceled') ? undefined : (e && e.error) || 'error'); };
        saying = u;
        synth.resume(); // a speech queue left paused would swallow the word
        synth.speak(u);
        watch = setTimeout(() => { try { synth.cancel(); } catch (e) { /* gone */ } end('silent'); }, 6000);
      } catch (e) { end('unavailable'); }
    };
    // Something still being said is stopped first. Speaking in the same breath as the stop loses the new
    // word in Chromium, so it follows a moment later.
    const begin = () => {
      let busy = false;
      try { busy = synth.speaking || synth.pending; if (busy) synth.cancel(); } catch (e) { /* carry on */ }
      if (busy) setTimeout(go, 90); else go();
    };
    // Just after the browser starts the list of voices may not have arrived yet.
    let have = 0;
    try { have = (synth.getVoices() || []).length; } catch (e) { /* none */ }
    if (have || typeof synth.addEventListener !== 'function') { begin(); return; }
    let waited = false;
    const ready = () => { if (waited) return; waited = true; synth.removeEventListener('voiceschanged', ready); begin(); };
    synth.addEventListener('voiceschanged', ready);
    setTimeout(ready, 500);
  }
  // A Listen button shows that it is speaking, and says so when no voice answered.
  function listen(btn, text, lang) {
    const turn = btn._turn = (btn._turn || 0) + 1; // a second click replaces the first; only the latest one reports
    btn.classList.remove('bad');
    btn.classList.add('on');
    btn.title = 'Listen';
    speak(text, lang, err => {
      if (btn._turn !== turn) return;
      btn.classList.remove('on');
      if (!err) return;
      btn.classList.add('bad');
      btn.title = 'No voice answered. Check that a voice for this language is installed on this computer.';
    });
  }

  function contextNode(sentence, term) {
    const i = sentence.toLowerCase().indexOf(term.toLowerCase());
    if (i < 0) return h('div', { class: 'ctx' }, sentence);
    return h('div', { class: 'ctx' }, sentence.slice(0, i), h('b', null, sentence.slice(i, i + term.length)), sentence.slice(i + term.length));
  }

  // info: { text, context, source: { docId, docTitle, url, page } }
  // handlers: { onSaved(entry) }
  async function showCard(rect, info, handlers) {
    ensure();
    hide();
    handlers = handlers || {};
    const text = info.text.replace(/\s+/g, ' ').trim();
    const long = text.length > 48;
    const body = h('div', null, h('div', { class: 'muted', style: 'margin-top:8px' }, h('span', { class: 'spin' }), 'Looking up...'));
    const card = h('div', { class: 'card', role: 'dialog', 'aria-label': 'Word' },
      h('div', { class: 'head' },
        h('span', { class: 'term' + (long ? ' long' : '') }, text),
        h('span', { class: 'ph' }),
        h('span', { class: 'grow' }),
        h('button', { class: 'icon', title: 'Close', 'aria-label': 'Close', onclick: hideCard }, '✕')
      ),
      body
    );
    cardEl = card;
    layer.appendChild(card);
    place(card, rect, 'below');

    // What the card leads with (Settings > Translation):
    //   definition  - the meaning in the text's own language; the translation waits behind a click
    //   both        - the definition, with the translation underneath
    //   translation - the translation first, definitions below it
    // Both answers are asked for at once and each is shown as soon as it arrives. Where there is no
    // definition (a phrase, a name, a language without a dictionary) the translation takes its place.
    const settings = await Store.getSettings().catch(() => ({}));
    const mode = settings.cardMode === 'translation' || settings.cardMode === 'both' ? settings.cardMode : 'definition';
    let res = null, dict = null, dictDone = long, showTr = false, savedEntry = null, existing = null, saveBtn = null, late = false;

    const defsNode = lead => h('div', { class: 'defs' + (lead ? ' lead' : '') }, dict.of ? h('div', { class: 'form' }, dict.form) : null, dict.defs.map(x =>
      h('div', null, x.pos ? h('span', { class: 'pos' }, x.pos) : null, x.definition, x.example ? h('div', { class: 'ex' }, '"' + x.example + '"') : null)));
    const trNodes = small => [
      res.translation ? h('div', { class: 'tr' + (long || small ? ' long' : '') }, res.translation) : null,
      res.alts && res.alts.length ? h('div', { class: 'alts' }, res.alts.slice(0, 4).map(a =>
        h('div', null, a.pos && a.pos !== 'other' ? h('span', { class: 'pos' }, a.pos) : null, a.terms.join(', ')))) : null
    ];
    const waiting = () => h('div', { class: 'muted', style: 'margin-top:8px' }, h('span', { class: 'spin' }), 'Looking up...');

    function render() {
      if (cardEl !== card) return;
      const haveDefs = !!(dict && dict.ok && (dict.defs || []).length);
      const trReady = !!(res && res.ok);
      body.textContent = '';
      if (res && !res.ok && dictDone && !haveDefs) {
        body.appendChild(h('div', { class: 'err' }, res.error || 'Lookup failed.'));
        place(card, rect, 'below');
        return;
      }
      const ph = (trReady && res.phonetic) || (haveDefs && dict.phonetic) || '';
      if (ph) card.querySelector('.ph').textContent = ph;
      if (!long && (trReady || haveDefs) && !card.querySelector('.say')) {
        card.querySelector('.head').insertBefore(
          h('button', { class: 'icon say', title: 'Listen', 'aria-label': 'Listen', onclick: e => listen(e.currentTarget, text, (dict && dict.ok && settings.sourceLang) || (res && res.src) || settings.sourceLang) }, '\u{1F50A}'),
          card.querySelector('.grow'));
      }
      if (mode === 'translation') {
        body.appendChild(trReady ? h('div', null, trNodes(false)) : waiting());
        if (haveDefs) body.appendChild(defsNode(false));
      } else if (haveDefs) {
        body.appendChild(defsNode(true));
        if (trReady && (mode === 'both' || showTr)) body.appendChild(h('div', { class: 'under' }, trNodes(true)));
        else if (trReady) {
          // kept in the page (hidden) so it is ready the moment it is asked for
          body.appendChild(h('div', { class: 'under', hidden: true }, trNodes(true)));
          body.appendChild(h('button', { class: 'more', onclick: () => { showTr = true; render(); } }, 'Show translation'));
        }
      } else if (dictDone || (late && trReady)) {
        body.appendChild(trReady ? h('div', null, trNodes(false)) : waiting());
      } else body.appendChild(waiting());

      if (info.context && info.context.length > text.length + 4) body.appendChild(contextNode(info.context, text));
      // the footer (source and Save) appears once the card has its lead content
      if (res && (trReady || haveDefs) && (mode === 'translation' || dictDone || late)) {
        const done = existing || savedEntry;
        saveBtn = h('button', { class: 'btn pri' }, savedEntry ? 'Saved' : existing ? 'In your vocabulary' : 'Save to vocabulary');
        saveBtn.disabled = !!done;
        saveBtn.addEventListener('click', save);
        const from = [haveDefs ? dict.source || 'Dictionary' : '', trReady && (mode !== 'definition' || showTr || !haveDefs) ? res.provider || '' : ''].filter(Boolean).join(' · ');
        body.appendChild(h('div', { class: 'foot' }, h('span', { class: 'prov' }, from), h('span', { class: 'grow' }), saveBtn));
      }
      place(card, rect, 'below');
    }
    async function save() {
      if (!saveBtn || saveBtn.disabled) return;
      saveBtn.disabled = true;
      const src = info.source || {};
      const ok = res && res.ok;
      savedEntry = await Store.saveVocab({
        term: text, translation: ok ? res.translation : '', alts: ok ? res.alts || [] : [],
        phonetic: (ok && res.phonetic) || (dict && dict.phonetic) || '', defs: (dict && dict.defs) || [], lang: (ok && res.src) || settings.sourceLang || '',
        contexts: info.context ? [{ sentence: info.context, docId: src.docId || '', docTitle: src.docTitle || '', url: src.url || '', page: src.page || null }] : []
      });
      if (cardEl === card && saveBtn) saveBtn.textContent = 'Saved';
      if (handlers.onSaved) handlers.onSaved(savedEntry);
    }

    Store.findVocab(text).then(v => { existing = v || null; render(); }).catch(() => {});
    // A dictionary that is slow to answer does not hold the card up: after a moment the translation is shown,
    // and the definition joins it if and when it arrives.
    setTimeout(() => { if (!dictDone && cardEl === card) { late = true; showTr = true; render(); } }, 2500);
    if (!long) {
      chrome.runtime.sendMessage({ type: 'define', text }).catch(() => null).then(d => {
        dict = d && d.ok ? d : null;
        dictDone = true;
        // a word saved before its definition arrived gets it added afterwards
        if (dict && savedEntry) Store.updateVocab(savedEntry.id, { defs: dict.defs, phonetic: savedEntry.phonetic || dict.phonetic || '' });
        render();
      });
    }
    try {
      res = await chrome.runtime.sendMessage({ type: 'lookup', text });
    } catch (e) {
      res = { ok: false, error: 'Margin was updated. Reload this page to continue.' };
    }
    if (!res) res = { ok: false, error: 'Lookup failed.' };
    render();
  }

  // hl: highlight object. handlers: { onColor(name), onNote(text), onDelete(), onTranslate() }
  function showEditor(rect, hl, handlers, opts) {
    ensure();
    hide();
    opts = opts || {};
    const ta = h('textarea', { placeholder: 'Add a note...' });
    ta.value = hl.note || '';
    let dirty = false;
    const flush = () => {
      if (dirty) { dirty = false; handlers.onNote(ta.value.trim()); }
    };
    ta.addEventListener('input', () => { dirty = true; });
    ta.addEventListener('blur', flush);
    const palette = opts.palette || Store.globalPalette(null);
    const colorRow = h('div', { class: 'row' });
    const renderDots = sel => {
      colorRow.textContent = '';
      dots(palette, sel, c => { handlers.onColor(c); renderDots(c); }).forEach(d => colorRow.appendChild(d));
      const cur = palette.find(c => c.id === sel);
      if (cur) colorRow.appendChild(h('span', { class: 'cname' }, cur.name));
    };
    renderDots(hl.kind === 'vocab' ? null : hl.color);
    const card = h('div', { class: 'card', role: 'dialog', 'aria-label': 'Highlight' },
      h('div', { class: 'quote' }, hl.text || (hl.kind === 'ink' ? 'Hand-drawn mark' : '')),
      colorRow,
      ta,
      h('div', { class: 'foot' },
        h('button', { class: 'btn danger', onclick: () => { dirty = false; cardEl = null; card.remove(); handlers.onDelete(); } }, 'Delete'),
        h('span', { class: 'grow' }),
        hl.text ? h('button', { class: 'btn', onclick: () => { flush(); handlers.onTranslate(); } }, 'Translate') : null,
        h('button', { class: 'btn pri', onclick: hideCard }, 'Done')
      )
    );
    card._onClose = flush;
    cardEl = card;
    layer.appendChild(card);
    place(card, rect, 'below');
    if (opts.focusNote) setTimeout(() => ta.focus(), 0);
  }

  function toast(msg) {
    ensure();
    layer.querySelectorAll('.toast').forEach(t => t.remove());
    const t = h('div', { class: 'toast', role: 'status' }, msg);
    layer.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, 2200);
  }

  // Extracts the sentence surrounding [start, end) from a block of text.
  function sentenceAround(text, start, end) {
    const MAX = 260;
    let a = start, b = end;
    while (a > 0 && start - a < MAX) {
      const c = text[a - 1];
      if (c === '\n') break;
      if (/[.!?…]/.test(c) && /\s/.test(text[a] || '') ) break;
      a--;
    }
    while (b < text.length && b - end < MAX) {
      const c = text[b];
      if (c === '\n') break;
      b++;
      if (/[.!?…]/.test(c) && (b >= text.length || /\s/.test(text[b]))) break;
    }
    return text.slice(a, b).replace(/\s+/g, ' ').trim();
  }

  function isOwn(target) {
    return !!host && target === host;
  }

  g.MarginUI = { setPrivate, showToolbar, showCard, showEditor, showColorForm, hide, hideToolbar, hideCard, isOpen, isOwn, toast, sentenceAround, h, speak, listen };
})(globalThis);
