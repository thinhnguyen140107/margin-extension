// Margin - shows a small "update ready" button on extension pages when newer files are waiting on disk.
(function () {
  'use strict';
  function show(version) {
    if (!version || document.getElementById('mg-update')) return;
    const b = document.createElement('button');
    b.id = 'mg-update';
    b.textContent = 'Margin ' + version + ' is ready - click to update';
    b.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483000;border:0;border-radius:999px;padding:9px 16px;' +
      'background:#2f6f5e;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 22px rgba(0,0,0,.3)';
    b.addEventListener('click', () => { b.textContent = 'Updating...'; chrome.runtime.sendMessage({ type: 'apply-update' }); });
    document.body.appendChild(b);
  }
  try {
    chrome.storage.session.get('updateReady').then(r => show(r.updateReady));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && changes.updateReady) show(changes.updateReady.newValue);
    });
    chrome.runtime.sendMessage({ type: 'check-update' }).catch(() => {});
  } catch (e) { /* not available */ }
})();
