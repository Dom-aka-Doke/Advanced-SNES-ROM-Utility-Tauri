'use strict';

// window.asru for the manual, about and heatmap windows (same interface as the Electron preload).
// The parameters (version, title, design) are handed over by the backend as window.__ASRU_QUERY
// and put into location.search, where the page scripts expect them.

(function bridgeChild() {
  if (window.__ASRU_QUERY && !window.location.search) {
    window.history.replaceState(null, '', `${window.location.pathname}?${window.__ASRU_QUERY}`);
  }

  const P = window.Platform;
  let requestId = 0;

  window.asru = {
    closeWindow: () => P.currentWindow().close(),
    openExternal: (url) => P.openExternal(url),
    onDesign: (callback) => P.listen('design', (modern) => callback(!!modern)),
    onRomChanged: (callback) => P.listen('rom-changed', () => callback()),

    /** Asks the main window for the bank analysis of the loaded ROM */
    getHeatmap(bankSize) {
      const id = `${Date.now()}-${++requestId}`;

      return new Promise((resolve) => {
        let unlisten = null;
        const finish = (data) => {
          clearTimeout(timer);
          if (unlisten) unlisten();
          resolve(data);
        };
        const timer = setTimeout(() => finish(null), 15000);

        P.listen('heatmap:data', (payload) => {
          if (payload && payload.id === id) finish(payload.data);
        }).then((fn) => {
          unlisten = fn;
          P.emit('heatmap:get', { id, bankSize });
        });
      });
    },
  };
})();
