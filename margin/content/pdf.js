// Margin - mounts the reader inside a PDF tab, so the address bar keeps the document's own URL.
(function () {
  'use strict';
  if (window.top !== window || document.contentType !== 'application/pdf' || window.__marginPdf) return;
  window.__marginPdf = true;
  const url = location.href.split('#')[0];

  function mount(readerBase) {
    // Replacing <body> drops the browser's own PDF viewer along with it.
    const body = document.createElement('body');
    body.style.cssText = 'margin:0;height:100vh;overflow:hidden;background:#16181b';
    if (document.body) document.documentElement.replaceChild(body, document.body);
    else document.documentElement.appendChild(body);
    document.documentElement.style.cssText = 'height:100%;overflow:hidden';
    let head = document.head;
    if (!head) {
      head = document.createElement('head');
      document.documentElement.insertBefore(head, body);
    }
    const icon = document.createElement('link');
    icon.rel = 'icon';
    icon.href = chrome.runtime.getURL('icons/icon32.png');
    head.appendChild(icon);

    const frame = document.createElement('iframe');
    frame.src = readerBase + '?embedded=1&file=' + encodeURIComponent(url);
    frame.allow = 'fullscreen; clipboard-write';
    frame.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;border:0';
    body.appendChild(frame);

    let ready = false;
    window.addEventListener('message', e => {
      if (e.source !== frame.contentWindow || !e.data || e.data.margin !== true) return;
      if (e.data.type === 'ready') ready = true;
      else if (e.data.type === 'title' && typeof e.data.title === 'string') document.title = e.data.title;
    });
    frame.addEventListener('load', () => frame.focus());
    window.addEventListener('focus', () => frame.focus());
    // Some servers forbid frames on their PDFs; fall back to the standalone reader page.
    setTimeout(() => {
      if (!ready) chrome.runtime.sendMessage({ type: 'pdf-redirect', url }).catch(() => {});
    }, 3500);
  }

  try {
    chrome.runtime.sendMessage({ type: 'pdf-detected', url }, res => {
      if (chrome.runtime.lastError || !res || !res.embed) return;
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mount(res.reader), { once: true });
      else mount(res.reader);
    });
  } catch (e) { /* extension reloaded */ }
})();
