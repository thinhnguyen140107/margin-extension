// Margin - turns one document's highlights and notes into a Word file, Markdown, or rich text for pasting.
// The Word file is deliberately plain (Times New Roman 13, black, no shading) so it can go straight into coursework.
(function (g) {
  'use strict';

  // opts: { title, source, citation: { html, text } | null, highlights (already in reading order), palette,
  //         pageOf(hl) -> printed page label, vocab: [entries] }
  function buildModel(opts) {
    const groups = [];
    for (const c of opts.palette) {
      const items = [];
      for (const hl of opts.highlights) {
        if (hl.kind === 'vocab' || hl.color !== c.id) continue;
        if (!hl.text && !hl.note) continue; // a bare pen stroke has nothing to export
        items.push({ text: hl.text || '', note: hl.note || '', page: hl.page ? String(opts.pageOf(hl)) : '', drawn: !hl.text });
      }
      if (items.length) groups.push({ name: c.name, items });
    }
    const words = [];
    const seen = new Set();
    for (const hl of opts.highlights) {
      if (hl.kind !== 'vocab' || !hl.text) continue;
      const key = hl.text.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = (opts.vocab || []).find(v => String(v.term || '').trim().toLowerCase() === key);
      // the meaning of a saved word: its definition first, the translation after it
      const def = entry && entry.defs && entry.defs[0] ? entry.defs[0].definition || '' : '', tr = entry ? entry.translation || '' : '';
      words.push({ term: hl.text, translation: def ? def + (tr ? ' (' + tr + ')' : '') : tr, page: hl.page ? String(opts.pageOf(hl)) : '' });
    }
    return {
      title: opts.title || 'Notes', source: opts.source || '', citation: opts.citation || null, groups, words,
      exported: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
      count: groups.reduce((n, grp) => n + grp.items.length, 0) + words.length
    };
  }

  const where = it => (it.page ? ' (p. ' + it.page + ')' : '');
  const quoted = it => (it.drawn ? '[Hand-drawn mark]' : '“' + it.text + '”') + where(it);

  // ------------------------------------------------------------ Markdown
  function toMarkdown(m) {
    const out = ['# ' + m.title, ''];
    if (m.citation) out.push(m.citation.html.replace(/<\/?i>/g, '*').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'), '');
    if (m.source) out.push('Source: ' + m.source, '');
    out.push('Notes exported ' + m.exported, '');
    for (const grp of m.groups) {
      out.push('## ' + grp.name, '');
      for (const it of grp.items) {
        out.push('> ' + quoted(it).replace(/\n/g, ' '), '');
        if (it.note) out.push('Note: ' + it.note.replace(/\n+/g, '  \n'), '');
      }
    }
    if (m.words.length) {
      out.push('## Saved words', '');
      for (const w of m.words) out.push('- **' + w.term + '**' + (w.translation ? ' - ' + w.translation : '') + (w.page ? ' (p. ' + w.page + ')' : ''));
      out.push('');
    }
    return out.join('\n');
  }

  // ------------------------------------------------------------ HTML (for the clipboard)
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function toHtml(m) {
    let html = '<h1>' + esc(m.title) + '</h1>';
    if (m.citation) html += '<p>' + m.citation.html + '</p>';
    if (m.source) html += '<p>Source: ' + esc(m.source) + '</p>';
    for (const grp of m.groups) {
      html += '<h2>' + esc(grp.name) + '</h2>';
      for (const it of grp.items) {
        html += '<p>' + esc(quoted(it)) + '</p>';
        if (it.note) html += '<p>Note: ' + esc(it.note).replace(/\n/g, '<br>') + '</p>';
      }
    }
    if (m.words.length) {
      html += '<h2>Saved words</h2><ul>' + m.words.map(w => '<li><b>' + esc(w.term) + '</b>' + (w.translation ? ' - ' + esc(w.translation) : '') + '</li>').join('') + '</ul>';
    }
    return html;
  }

  // ------------------------------------------------------------ Word (.docx), written by hand: a ZIP of XML parts
  const xml = s => String(s).replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  function run(text, fmt) {
    fmt = fmt || {};
    const props = (fmt.bold ? '<w:b/>' : '') + (fmt.italic ? '<w:i/>' : '') + (fmt.underline ? '<w:u w:val="single"/>' : '') + (fmt.size ? '<w:sz w:val="' + fmt.size + '"/><w:szCs w:val="' + fmt.size + '"/>' : '');
    const parts = String(text).split('\n');
    return '<w:r>' + (props ? '<w:rPr>' + props + '</w:rPr>' : '') +
      parts.map((p, i) => (i ? '<w:br/>' : '') + '<w:t xml:space="preserve">' + xml(p) + '</w:t>').join('') + '</w:r>';
  }
  function para(runs, opt) {
    opt = opt || {};
    const pPr = (opt.style ? '<w:pStyle w:val="' + opt.style + '"/>' : '') + (opt.keepNext ? '<w:keepNext/>' : '') +
      '<w:spacing w:before="' + (opt.before || 0) + '" w:after="' + (opt.after == null ? 120 : opt.after) + '"/>' +
      (opt.indent ? '<w:ind w:left="' + opt.indent + '"/>' : '') + (opt.hanging ? '<w:ind w:left="' + opt.hanging + '" w:hanging="' + opt.hanging + '"/>' : '');
    return '<w:p><w:pPr>' + pPr + '</w:pPr>' + runs + '</w:p>';
  }

  function toDocxParts(m) {
    const links = [];
    const link = (url, label) => {
      links.push(url);
      return '<w:hyperlink r:id="rIdL' + links.length + '" w:history="1">' + run(label, { underline: true }) + '</w:hyperlink>';
    };
    // Text that may contain web addresses -> runs with real hyperlinks.
    const linked = (text, fmt) => text.split(/(https?:\/\/[^\s<>"]+[^\s<>".,;:)\]])/).map((piece, i) => (i % 2 ? link(piece, piece) : piece ? run(piece, fmt) : '')).join('');

    let body = para(run(m.title, { bold: true, size: 32 }), { after: 200 });
    if (m.citation) {
      const runs = m.citation.html.replace(/<\/?pre>/g, '').split(/(<i>|<\/i>)/).reduce((acc, tok) => {
        if (tok === '<i>') acc.italic = true;
        else if (tok === '</i>') acc.italic = false;
        else if (tok) acc.out += linked(unesc(tok), { italic: acc.italic });
        return acc;
      }, { out: '', italic: false }).out;
      body += para(runs, { hanging: 720, after: 160 });
    }
    if (m.source) body += para(run('Source: ') + linked(m.source), { after: 60 });
    body += para(run('Notes exported ' + m.exported + '.'), { after: 240 });
    for (const grp of m.groups) {
      body += para(run(grp.name, { bold: true, size: 28 }), { before: 240, after: 120, keepNext: true });
      for (const it of grp.items) {
        body += para(run(quoted(it)), { after: it.note ? 40 : 160 });
        if (it.note) body += para(run('Note: ', { italic: true }) + linked(it.note), { indent: 360, after: 160 });
      }
    }
    if (m.words.length) {
      body += para(run('Saved words', { bold: true, size: 28 }), { before: 240, after: 120, keepNext: true });
      for (const w of m.words) body += para(run(w.term, { bold: true }) + run((w.translation ? ' – ' + w.translation : '') + (w.page ? ' (p. ' + w.page + ')' : '')), { after: 60 });
    }

    const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    return {
      '[Content_Types].xml': head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
      '_rels/.rels': head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/_rels/document.xml.rels': head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        links.map((u, i) => '<Relationship Id="rIdL' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + xml(u) + '" TargetMode="External"/>').join('') +
        '</Relationships>',
      'word/styles.xml': head + '<w:styles ' + NS + '><w:docDefaults><w:rPrDefault><w:rPr>' +
        '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:color w:val="000000"/><w:sz w:val="26"/><w:szCs w:val="26"/><w:lang w:val="en-US"/>' +
        '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>',
      'word/document.xml': head + '<w:document ' + NS + '><w:body>' + body +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>'
    };
  }

  // Minimal ZIP writer (stored, no compression) - enough for Word and LibreOffice to open.
  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function zip(files) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    const u16 = n => [n & 255, (n >>> 8) & 255], u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
    for (const name of Object.keys(files)) {
      const nameB = enc.encode(name), data = enc.encode(files[name]), crc = crc32(data);
      const common = [].concat(u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(nameB.length), u16(0));
      const local = new Uint8Array([0x50, 0x4b, 3, 4].concat(common));
      chunks.push(local, nameB, data);
      central.push(new Uint8Array([0x50, 0x4b, 1, 2].concat(u16(20), common, u16(0), u16(0), u16(0), u32(0), u32(offset))), nameB);
      offset += local.length + nameB.length + data.length;
    }
    const cdSize = central.reduce((n, c) => n + c.length, 0), count = Object.keys(files).length;
    const end = new Uint8Array([0x50, 0x4b, 5, 6].concat(u16(0), u16(0), u16(count), u16(count), u32(cdSize), u32(offset), u16(0)));
    return new Blob(chunks.concat(central, [end]), { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }
  const toDocx = m => zip(toDocxParts(m));

  function fileName(title, ext) {
    const base = String(title || 'notes').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim() || 'notes';
    return base + ' - notes.' + ext;
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // format: 'docx' | 'md' | 'copy'. Returns a short message for the user.
  async function run_(format, opts) {
    const m = buildModel(opts);
    if (!m.count) return 'Nothing to export yet - highlight some text first.';
    if (format === 'docx') { download(toDocx(m), fileName(m.title, 'docx')); return 'Word file saved to your downloads'; }
    if (format === 'md') { download(new Blob([toMarkdown(m)], { type: 'text/markdown' }), fileName(m.title, 'md')); return 'Markdown file saved to your downloads'; }
    const html = toHtml(m), text = toMarkdown(m);
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
    } catch (e) { await navigator.clipboard.writeText(text); }
    return 'Notes copied - paste them into your document';
  }

  // A small "Export notes" drop-down. getOpts() is called at export time; say(message) shows the result.
  // extra: optional [[value, label, handler], ...] for exports only one page can do (e.g. the PDF itself).
  function menu(getOpts, say, extra) {
    const sel = document.createElement('select');
    sel.className = 'exportsel';
    sel.setAttribute('aria-label', 'Export notes');
    [['', 'Export notes'], ['docx', 'Word (.docx)'], ['md', 'Markdown (.md)'], ['copy', 'Copy to clipboard']].concat((extra || []).map(x => [x[0], x[1]])).forEach(([v, l]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = l;
      if (!v) o.hidden = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', async () => {
      const format = sel.value;
      sel.value = '';
      if (!format) return;
      const special = (extra || []).find(x => x[0] === format);
      if (special) { try { say(await special[2]()); } catch (e) { say('Export failed: ' + (e && e.message || e)); } return; }
      try { say(await run_(format, await getOpts())); } catch (e) { say('Export failed: ' + (e && e.message || e)); }
    });
    return sel;
  }

  g.MarginExport = { buildModel, toMarkdown, toHtml, toDocx, toDocxParts, run: run_, menu, fileName, download };
})(globalThis);
