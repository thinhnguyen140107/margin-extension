// Margin - bibliographic details and citation formatting for the document being read.
// A "meta" record: { type: 'article'|'chapter'|'book'|'other', authors: [{ family, given }], editors: [...],
//   title, container, publisher, year, volume, issue, pages, doi, url, firstPage }

export const STYLES = [['apa', 'APA 7'], ['mla', 'MLA 9'], ['chicago', 'Chicago'], ['harvard', 'Harvard'], ['bibtex', 'BibTeX']];

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clean = s => String(s == null ? '' : s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const endsPunct = s => /[.?!]["'”’)]?$/.test(s);
const dot = s => (s ? (endsPunct(s) ? s : s + '.') : '');
const dash = p => String(p || '').replace(/\s*[-‐-―]+\s*/g, '–');
const doiUrl = m => (m.doi ? 'https://doi.org/' + m.doi : m.url && /^https?:/i.test(m.url) ? m.url : '');

// ------------------------------------------------------------ names
export function parseName(raw) {
  const s = clean(raw);
  if (!s) return null;
  if (s.includes(',')) {
    const [family, ...rest] = s.split(',');
    return { family: family.trim(), given: rest.join(',').trim() };
  }
  const parts = s.split(' ');
  if (parts.length === 1) return { family: parts[0], given: '' };
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') };
}
// "Family, Given; Family, Given" or one name per line; also accepts "Given Family and Given Family".
export function parseNames(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  const pieces = /[;\n]/.test(s) ? s.split(/[;\n]+/) : s.split(/\s+(?:and|&)\s+/i);
  return pieces.map(parseName).filter(Boolean);
}
export const namesToText = list => (list || []).map(n => (n.given ? n.family + ', ' + n.given : n.family)).join('; ');

function initials(given) {
  return clean(given).split(/\s+/).filter(Boolean)
    .map(w => w.split('-').map(p => (p ? p[0].toLocaleUpperCase() + '.' : '')).join('-')).join(' ');
}
const famGiven = n => (n.given ? n.family + ', ' + n.given : n.family);
const givenFam = n => (n.given ? n.given + ' ' + n.family : n.family);
const famInit = n => (n.given ? n.family + ', ' + initials(n.given) : n.family);
const initFam = n => (n.given ? initials(n.given) + ' ' + n.family : n.family);

function join(list, lastSep, sep) {
  sep = sep || ', ';
  if (list.length <= 1) return list.join('');
  if (list.length === 2) return list[0] + lastSep.replace(/^,/, '') + list[1];
  return list.slice(0, -1).join(sep) + lastSep + list[list.length - 1];
}

// ------------------------------------------------------------ styles (each returns HTML; <i> marks italics)
function apa(m) {
  const names = m.authors.slice(0, 20).map(famInit);
  const A = names.length > 1 ? names.slice(0, -1).join(', ') + ', & ' + names[names.length - 1] : names.join('');
  const Y = '(' + (m.year || 'n.d.') + ').';
  const T = esc(m.title);
  const link = doiUrl(m);
  let body;
  if (m.type === 'book') body = dot('<i>' + T + '</i>') + (m.publisher ? ' ' + dot(esc(m.publisher)) : '');
  else if (m.type === 'chapter') {
    const eds = m.editors.length ? join(m.editors.map(initFam), ', & ') + (m.editors.length > 1 ? ' (Eds.), ' : ' (Ed.), ') : '';
    body = dot(T) + ' In ' + esc(eds) + '<i>' + esc(m.container) + '</i>' + (m.pages ? ' (pp. ' + dash(m.pages) + ')' : '') + '.' +
      (m.publisher ? ' ' + dot(esc(m.publisher)) : '');
  } else {
    let src = m.container ? '<i>' + esc(m.container) + '</i>' : '';
    if (m.volume) src += (src ? ', ' : '') + '<i>' + esc(m.volume) + '</i>' + (m.issue ? '(' + esc(m.issue) + ')' : '');
    if (m.pages) src += (src ? ', ' : '') + dash(m.pages);
    body = dot(T) + (src ? ' ' + src + '.' : '') + (!m.container && m.publisher ? ' ' + dot(esc(m.publisher)) : '');
  }
  const head = A ? dot(esc(A)) + ' ' + Y + ' ' + body : body.replace(/^(.*?[.?!])(\s|$)/, '$1 ' + Y + '$2');
  return head + (link ? ' ' + esc(link) : '');
}

function leadNames(m, max) {
  const a = m.authors;
  if (!a.length) return '';
  if (a.length === 1) return famGiven(a[0]);
  if (a.length === 2) return famGiven(a[0]) + ', and ' + givenFam(a[1]);
  if (a.length > max) return famGiven(a[0]) + ', et al';
  const rest = a.slice(1).map(givenFam);
  return famGiven(a[0]) + ', ' + rest.slice(0, -1).join(', ') + ', and ' + rest[rest.length - 1];
}

function mla(m) {
  const A = leadNames(m, 2);
  const T = esc(m.title), q = '“' + T + (endsPunct(m.title) ? '' : '.') + '”';
  const link = doiUrl(m);
  const parts = [];
  let s = A ? dot(esc(A)) + ' ' : '';
  if (m.type === 'book') {
    s += dot('<i>' + T + '</i>');
    if (m.publisher) parts.push(esc(m.publisher));
    if (m.year) parts.push(esc(m.year));
  } else {
    s += q;
    if (m.container) parts.push('<i>' + esc(m.container) + '</i>');
    if (m.type === 'chapter') {
      if (m.editors.length) parts.push('edited by ' + esc(join(m.editors.map(givenFam), ', and ', ', ')));
      if (m.publisher) parts.push(esc(m.publisher));
    } else {
      if (m.volume) parts.push('vol. ' + esc(m.volume));
      if (m.issue) parts.push('no. ' + esc(m.issue));
    }
    if (m.year) parts.push(esc(m.year));
    if (m.pages) parts.push((/[-–]/.test(dash(m.pages)) ? 'pp. ' : 'p. ') + dash(m.pages));
  }
  return s + (parts.length ? ' ' + parts.join(', ') + '.' : '') + (link ? ' ' + esc(link) + '.' : '');
}

function chicago(m) {
  const A = leadNames(m, 10);
  const T = esc(m.title), q = '“' + T + (endsPunct(m.title) ? '' : '.') + '”';
  const link = doiUrl(m);
  let s = A ? dot(esc(A)) + ' ' : '';
  if (m.type === 'book') {
    s += dot('<i>' + T + '</i>') + ' ' + [m.publisher, m.year].filter(Boolean).map(esc).join(', ') + '.';
  } else if (m.type === 'chapter') {
    s += q + ' In <i>' + esc(m.container) + '</i>' +
      (m.editors.length ? ', edited by ' + esc(join(m.editors.map(givenFam), ', and ', ', ')) : '') +
      (m.pages ? ', ' + dash(m.pages) : '') + '. ' + [m.publisher, m.year].filter(Boolean).map(esc).join(', ') + '.';
  } else {
    s += q + (m.container ? ' <i>' + esc(m.container) + '</i>' : '') + (m.volume ? ' ' + esc(m.volume) : '') +
      (m.issue ? ', no. ' + esc(m.issue) : '') + (m.year ? ' (' + esc(m.year) + ')' : '') + (m.pages ? ': ' + dash(m.pages) : '') + '.';
  }
  return s.replace(/\s+\./g, '.') + (link ? ' ' + esc(link) + '.' : '');
}

function harvard(m) {
  const A = join(m.authors.map(famInit), ' and ');
  const Y = '(' + (m.year || 'no date') + ')';
  const T = esc(m.title);
  const link = m.doi ? 'doi: ' + m.doi : doiUrl(m) ? 'Available at: ' + doiUrl(m) : '';
  let s = (A ? esc(A) + ' ' + Y + ' ' : '');
  if (m.type === 'book') s += '<i>' + T + '</i>' + (A ? '' : ' ' + Y) + '. ' + (m.publisher ? dot(esc(m.publisher)) : '');
  else if (m.type === 'chapter') {
    const eds = m.editors.length ? esc(join(m.editors.map(famInit), ' and ')) + (m.editors.length > 1 ? ' (eds.) ' : ' (ed.) ') : '';
    s += '‘' + T + '’' + (A ? '' : ' ' + Y) + ', in ' + eds + '<i>' + esc(m.container) + '</i>. ' +
      (m.publisher ? esc(m.publisher) : '') + (m.pages ? (m.publisher ? ', ' : '') + 'pp. ' + dash(m.pages) : '') + '.';
  } else {
    s += '‘' + T + '’' + (A ? '' : ' ' + Y) + (m.container ? ', <i>' + esc(m.container) + '</i>' : '') +
      (m.volume ? ', ' + esc(m.volume) + (m.issue ? '(' + esc(m.issue) + ')' : '') : '') + (m.pages ? ', pp. ' + dash(m.pages) : '') + '.';
  }
  return s.trim() + (link ? ' ' + esc(link) + '.' : '');
}

export function citeKey(m) {
  const fam = (m.authors[0] ? m.authors[0].family : (m.title || 'ref')).normalize('NFD').replace(/[^A-Za-z]/g, '').toLowerCase().slice(0, 16) || 'ref';
  const word = (clean(m.title).normalize('NFD').replace(/[^A-Za-z ]/g, '').toLowerCase().split(' ').find(w => w.length > 3) || '');
  return fam + (m.year || '') + word;
}
function bibtex(m) {
  const kind = m.type === 'article' ? 'article' : m.type === 'chapter' ? 'incollection' : m.type === 'book' ? 'book' : 'misc';
  const names = l => l.map(n => (n.given ? n.family + ', ' + n.given : '{' + n.family + '}')).join(' and ');
  const f = [];
  if (m.authors.length) f.push(['author', names(m.authors)]);
  f.push(['title', '{' + m.title + '}']);
  if (m.container) f.push([m.type === 'article' ? 'journal' : 'booktitle', m.container]);
  if (m.editors.length) f.push(['editor', names(m.editors)]);
  if (m.publisher) f.push(['publisher', m.publisher]);
  if (m.year) f.push(['year', m.year]);
  if (m.volume) f.push(['volume', m.volume]);
  if (m.issue) f.push(['number', m.issue]);
  if (m.pages) f.push(['pages', String(m.pages).replace(/\s*[-‐-―]+\s*/g, '--')]);
  if (m.doi) f.push(['doi', m.doi]);
  else if (m.url && /^https?:/i.test(m.url)) f.push(['url', m.url]);
  return '@' + kind + '{' + citeKey(m) + ',\n' + f.map(([k, v]) => '  ' + k + ' = {' + v + '}').join(',\n') + '\n}';
}

function norm(meta) {
  const m = Object.assign({ type: 'other', title: '', container: '', publisher: '', year: '', volume: '', issue: '', pages: '', doi: '', url: '' }, meta);
  m.authors = (meta.authors || []).filter(n => n && n.family);
  m.editors = (meta.editors || []).filter(n => n && n.family);
  m.title = clean(m.title) || 'Untitled';
  return m;
}

// -> { html, text }
export function formatCitation(meta, style) {
  const m = norm(meta);
  if (style === 'bibtex') {
    const text = bibtex(m);
    return { html: '<pre>' + esc(text) + '</pre>', text };
  }
  const html = (style === 'mla' ? mla : style === 'chicago' ? chicago : style === 'harvard' ? harvard : apa)(m)
    .replace(/\s{2,}/g, ' ').replace(/\.\./g, '.').trim();
  const text = html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return { html, text };
}

// Parenthetical reference for a quotation, e.g. (Nguyen, 2018, p. 84)
export function inText(meta, style, page) {
  const m = norm(meta);
  const a = m.authors;
  const short = '“' + m.title.split(/[:.?!]/)[0].split(' ').slice(0, 4).join(' ') + '”';
  const who = and => (!a.length ? short : a.length === 1 ? a[0].family : a.length === 2 ? a[0].family + and + a[1].family : a[0].family + ' et al.');
  const y = m.year || 'n.d.';
  if (style === 'bibtex') return '\\cite' + (page ? '[p.~' + page + ']' : '') + '{' + citeKey(m) + '}';
  if (style === 'mla') return '(' + who(' and ') + (page ? ' ' + page : '') + ')';
  if (style === 'chicago') return '(' + who(' and ') + ' ' + y + (page ? ', ' + page : '') + ')';
  if (style === 'harvard') return '(' + who(' and ') + ', ' + y + (page ? ', p. ' + page : '') + ')';
  return '(' + who(' & ') + ', ' + y + (page ? ', p. ' + page : '') + ')';
}

// ------------------------------------------------------------ finding the work
export function findDoi(text) {
  const m = /\b(10\.\d{4,9}\/[^\s"'<>]*[^\s"'<>.,;:)\]}])/i.exec(String(text || ''));
  return m ? m[1] : '';
}

const tokens = s => new Set(clean(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2));
// 0..1: how alike two titles are (shared words over the larger set).
export function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}

const TYPES = {
  'journal-article': 'article', 'proceedings-article': 'chapter', 'book-chapter': 'chapter', 'book-section': 'chapter', 'book-part': 'chapter',
  book: 'book', monograph: 'book', 'edited-book': 'book', 'reference-book': 'book'
};
export function fromCrossref(it) {
  const people = l => (l || []).map(p => (p.family ? { family: clean(p.family), given: clean(p.given) } : p.name ? { family: clean(p.name), given: '' } : null)).filter(Boolean);
  const date = it.issued || it['published-print'] || it['published-online'] || it.published || {};
  const year = date['date-parts'] && date['date-parts'][0] && date['date-parts'][0][0];
  return {
    type: TYPES[it.type] || 'other',
    authors: people(it.author), editors: people(it.editor),
    title: clean((it.title || [])[0]) + ((it.subtitle || [])[0] && !clean((it.title || [])[0]).includes(clean(it.subtitle[0])) ? ': ' + clean(it.subtitle[0]) : ''),
    container: clean((it['container-title'] || [])[0]), publisher: clean(it.publisher),
    year: year ? String(year) : '', volume: clean(it.volume), issue: clean(it.issue), pages: clean(it.page), doi: clean(it.DOI), url: ''
  };
}

// If the work's page range matches the PDF's length, work out the printed number of PDF page 1.
export function inferFirstPage(pages, numPages) {
  const m = /^(\d+)\s*[-‐-―]+\s*(\d+)$/.exec(clean(pages));
  if (!m) return 0;
  const first = Number(m[1]), count = Number(m[2]) - first + 1, extra = numPages - count;
  return extra >= 0 && extra <= 2 ? first - extra : 0;
}
