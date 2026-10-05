// Margin - toolbar popup.
(async function () {
  'use strict';
  const Store = MarginStore;
  const $ = id => document.getElementById(id);
  const READER = chrome.runtime.getURL('reader/reader.html');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || '';

  const due = (await Store.dueVocab()).length;
  $('due').textContent = due ? due + ' due' : 'none due';
  const docs = await Store.listDocs();
  $('count').textContent = docs.length ? docs.length + ' document' + (docs.length === 1 ? '' : 's') : '';

  // Only needed when automatic opening is switched off; otherwise the reader is already on the page.
  if (!(await Store.getSettings()).autoOpenPdf && /^(https?|file):/i.test(url) && /\.pdf($|[?#])/i.test(url)) {
    $('thisPdf').hidden = false;
    $('thisPdf').addEventListener('click', () => {
      chrome.tabs.update(tab.id, { url: READER + '?file=' + encodeURIComponent(url) });
      window.close();
    });
  }
  $('openPdf').addEventListener('click', () => { chrome.tabs.create({ url: READER }); window.close(); });
  $('review').addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'open-dashboard', hash: 'review' }); window.close(); });
  $('dash').addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'open-dashboard', hash: 'library' }); window.close(); });

  let host = '';
  try { if (/^https?:/i.test(url)) host = new URL(url).hostname; } catch (e) { /* not a web page */ }
  if (host) {
    const s = await Store.getSettings();
    $('siteRow').hidden = false;
    $('siteLabel').textContent = 'Selection toolbar on ' + host;
    $('site').checked = s.webEnabled && !s.disabledHosts.includes(host);
    $('site').disabled = !s.webEnabled;
    $('site').addEventListener('change', async () => {
      const cur = await Store.getSettings();
      const list = cur.disabledHosts.filter(h => h !== host);
      if (!$('site').checked) list.push(host);
      await Store.setSettings({ disabledHosts: list });
    });
  }

  $('saveNote').addEventListener('click', async () => {
    const body = $('quick').value.trim();
    if (!body) return;
    const isPage = /^https?:/i.test(url);
    await Store.saveNote({ title: isPage ? (tab.title || host) : '', body, sourceUrl: isPage ? url : '' });
    $('quick').value = '';
    $('hint').textContent = 'Saved to Notes.';
  });
})();
