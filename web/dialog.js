'use strict';

// Shared script of the About and Manual windows

(function init() {
  const params = new URLSearchParams(window.location.search);
  const setModern = (modern) => document.body.classList.toggle('modern', modern);
  setModern(params.get('modern') === '1');
  if (window.asru.onDesign) window.asru.onDesign(setModern);
  const version = params.get('version');
  const title = params.get('title');

  const versionEl = document.getElementById('version');
  if (versionEl && version) versionEl.textContent = version.replace(/\.0$/, '');

  if (title) {
    document.title = document.body.classList.contains('manual') ? `Manual of the ${title}` : `About the ${title}`;
  }

  const close = document.getElementById('btnClose');
  if (close) close.addEventListener('click', () => window.asru.closeWindow());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.asru.closeWindow();
  });

  // Open external links in the default browser
  document.querySelectorAll('a[href^="http"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.asru.openExternal(a.href);
    });
  });
})();
