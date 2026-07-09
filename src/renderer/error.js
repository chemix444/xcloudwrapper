'use strict';

// Local retry page shown instead of Chromium's default error page.
// window.xcloudHost is exposed by the preload; the retry channel is
// validated in the main process against this page's file:// URL.

const params = new URLSearchParams(location.search);
const description = params.get('description');
const code = params.get('code');
const url = params.get('url');

if (description) {
  document.getElementById('description').textContent =
    'Could not load Xbox Cloud Gaming. Check your internet connection.';
  document.getElementById('detail').textContent =
    `${description}${code ? ` (${code})` : ''}${url ? ` — ${url}` : ''}`;
}

function retry() {
  if (window.xcloudHost) window.xcloudHost.retry();
}

document.getElementById('retry').addEventListener('click', retry);

// Auto-retry when the network comes back, and keep trying every 15s while
// the page is up (cheap: a failed retry just lands back here).
window.addEventListener('online', retry);
setInterval(() => {
  if (navigator.onLine) retry();
}, 15000);
