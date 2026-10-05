// Margin - writes highlights, pen marks and notes into a copy of the PDF as standard annotations,
// so they show up in any PDF reader (Acrobat, Edge, Preview, a phone...). The original file is not touched.
const rgb = hex => {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(v => +v.toFixed(4));
};
const f = n => (Math.round(n * 100) / 100).toString();

// opts: { PDFLib, bytes, pdf (PDF.js document), highlights, hexOf(colorId), labelOf(colorId), vocab }
export async function annotatedPdf(opts) {
  const { PDFDocument, PDFName, PDFHexString, PDFString } = opts.PDFLib;
  const out = await PDFDocument.load(opts.bytes, { updateMetadata: false });
  const ctx = out.context;
  const pages = out.getPages();
  const now = PDFString.fromDate(new Date());

  // Re-exporting an already annotated copy: drop our earlier annotations first.
  for (const page of pages) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const ref = annots.get(i);
      const dict = ctx.lookup(ref);
      const nm = dict && dict.get && dict.get(PDFName.of('NM'));
      if (nm && typeof nm.decodeText === 'function' && nm.decodeText().startsWith('margin-')) page.node.removeAnnot(ref);
    }
  }

  const byPage = new Map();
  const add = (p, hl) => { if (!byPage.has(p)) byPage.set(p, []); if (!byPage.get(p).includes(hl)) byPage.get(p).push(hl); };
  for (const hl of opts.highlights) {
    if (hl.kind === 'ink') { if ((hl.points || []).length) add(hl.page, hl); } else for (const r of hl.rects || []) add(r.page, hl);
  }

  let count = 0;
  for (const [p, marks] of byPage) {
    if (p < 1 || p > pages.length) continue;
    const vp = (await opts.pdf.getPage(p)).getViewport({ scale: 1 });
    const P = (fx, fy) => vp.convertToPdfPoint(fx * vp.width, fy * vp.height);
    // rectangles saved by version 1.0 were measured against a slightly smaller page box
    const w0 = vp.width * (96 / 72) * 1.25, h0 = vp.height * (96 / 72) * 1.25;
    const kx = (w0 - 18) / w0, ky = (h0 - 18) / h0;

    for (const hl of marks) {
      const color = rgb(hl.kind === 'vocab' ? '#2f8f76' : opts.hexOf(hl.color));
      const label = hl.kind === 'vocab' ? 'Saved word' : opts.labelOf(hl.color);
      const word = hl.kind === 'vocab' ? (opts.vocab || []).find(v => String(v.term || '').trim().toLowerCase() === String(hl.text || '').trim().toLowerCase()) : null;
      const contents = [label, word && word.translation ? hl.text + ' - ' + word.translation : '', hl.note || ''].filter(Boolean).join('\n');
      const xs = [], ys = [];
      const track = pt => { xs.push(pt[0]); ys.push(pt[1]); return pt; };
      let dict, stream, pad = 1;

      if (hl.kind === 'ink') {
        const pts = hl.points.map(pt => track(P(pt[0], pt[1])));
        const width = Math.max(0.5, hl.width * vp.width);
        const marker = hl.tool !== 'pen';
        pad = width;
        const path = pts.map((pt, i) => f(pt[0]) + ' ' + f(pt[1]) + (i ? ' l' : ' m')).join(' ') + (pts.length === 1 ? ' ' + f(pts[0][0] + 0.1) + ' ' + f(pts[0][1]) + ' l' : '');
        stream = { ops: '/GS0 gs ' + color.join(' ') + ' RG ' + f(width) + ' w 1 J 1 j ' + path + ' S', gs: marker ? { BM: 'Multiply', CA: 0.42 } : { CA: 1 } };
        dict = { Subtype: 'Ink', InkList: [pts.flat().map(n => +f(n))], BS: { W: +f(width), LC: 1 }, CA: marker ? 0.42 : 1 };
      } else {
        const quads = [];
        let ops = '';
        for (const r0 of hl.rects) {
          if (r0.page !== p) continue;
          const r = hl.v ? r0 : { x: r0.x * kx, y: r0.y * ky, w: r0.w * kx, h: r0.h * ky };
          const tl = track(P(r.x, r.y)), tr = track(P(r.x + r.w, r.y)), bl = track(P(r.x, r.y + r.h)), br = track(P(r.x + r.w, r.y + r.h));
          quads.push(...tl, ...tr, ...bl, ...br);
          ops += hl.kind === 'vocab'
            ? f(bl[0]) + ' ' + f(bl[1]) + ' m ' + f(br[0]) + ' ' + f(br[1]) + ' l S '
            : f(tl[0]) + ' ' + f(tl[1]) + ' m ' + f(tr[0]) + ' ' + f(tr[1]) + ' l ' + f(br[0]) + ' ' + f(br[1]) + ' l ' + f(bl[0]) + ' ' + f(bl[1]) + ' l h f ';
        }
        if (!quads.length) continue;
        if (hl.kind === 'vocab') {
          stream = { ops: '/GS0 gs ' + color.join(' ') + ' RG 1 w [2 2] 0 d ' + ops, gs: { CA: 1 } };
          dict = { Subtype: 'Underline', QuadPoints: quads.map(n => +f(n)) };
        } else {
          stream = { ops: '/GS0 gs ' + color.join(' ') + ' rg ' + ops, gs: { BM: 'Multiply', ca: 0.45 } };
          dict = { Subtype: 'Highlight', QuadPoints: quads.map(n => +f(n)), CA: 0.45 };
        }
      }
      const rect = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad].map(n => +f(n));
      const ap = ctx.register(ctx.stream(stream.ops, {
        Type: 'XObject', Subtype: 'Form', BBox: rect, Resources: { ExtGState: { GS0: Object.assign({ Type: 'ExtGState' }, stream.gs) } }
      }));
      const annot = ctx.obj(Object.assign({ Type: 'Annot', Rect: rect, C: color, F: 4, AP: { N: ap } }, dict));
      annot.set(PDFName.of('NM'), PDFHexString.fromText('margin-' + hl.id + '-' + p));
      annot.set(PDFName.of('T'), PDFHexString.fromText('Margin'));
      annot.set(PDFName.of('M'), now);
      if (contents) annot.set(PDFName.of('Contents'), PDFHexString.fromText(contents));
      pages[p - 1].node.addAnnot(ctx.register(annot));
      count++;
    }
  }
  return { bytes: await out.save(), count };
}
