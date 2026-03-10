/* ============================================================
   Chef de Commis — Background Service Worker
   ============================================================ */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.action !== 'REOPEN_POPUP') return;

  chrome.action.openPopup().catch(function (err) {
    console.error('Chef de Commis: could not reopen popup —', err);
  });
});
