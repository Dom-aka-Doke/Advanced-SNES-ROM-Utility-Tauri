'use strict';

// Thin wrapper around the Tauri API (window.__TAURI__, see "withGlobalTauri").
// Everything that needs the operating system goes through here.

window.Platform = (function platform() {
  const T = window.__TAURI__;
  const invoke = (cmd, args, options) => T.core.invoke(cmd, args, options);

  return {
    /* ---------------------------- files ---------------------------- */

    /** @returns {Promise<{exists: boolean, isFile: boolean, isDir: boolean, size: number}>} */
    fileInfo: (path) => invoke('file_info', { path }),

    /** @returns {Promise<Uint8Array>} */
    async readFile(path) {
      const result = await invoke('read_file', { path });
      return new Uint8Array(result);
    },

    /** Writes bytes (raw request body, no JSON conversion) */
    writeFile: (path, data) => invoke('write_file', data, { headers: { 'x-path': encodeURIComponent(path) } }),

    startupFile: () => invoke('startup_file'),
    defaultFolder: () => invoke('default_folder'),

    /* --------------------------- settings -------------------------- */

    loadSettings: () => invoke('load_settings'),
    saveSettings: (json) => invoke('save_settings', { json }),

    /* ---------------------------- dialogs -------------------------- */

    /** @returns {Promise<string|null>} */
    async openDialog({ defaultPath, filters }) {
      const res = await T.dialog.open({ defaultPath, filters, multiple: false, directory: false });
      return Array.isArray(res) ? res[0] || null : res || null;
    },

    /** @returns {Promise<string|null>} */
    async saveDialog({ defaultPath, filters }) {
      return (await T.dialog.save({ defaultPath, filters })) || null;
    },

    /* ---------------------------- windows -------------------------- */

    openWindow: (kind, options) => invoke('open_window', { kind, ...options }),

    /**
     * Makes the content area of the current window exactly width x height (logical pixels).
     * On Windows and Linux the menu bar takes space from the window's inner size.
     */
    async fitContent(width, height) {
      const win = T.window.getCurrentWindow();
      const missingW = width - window.innerWidth;
      const missingH = height - window.innerHeight;
      if (window.innerHeight > 0 && (missingW > 0 || missingH > 0)) {
        await win.setSize(new T.dpi.LogicalSize(width + Math.max(0, missingW), height + Math.max(0, missingH)));
      }
    },
    setDesignMenu: (modern) => invoke('set_design_menu', { modern }),
    currentWindow: () => T.window.getCurrentWindow(),
    currentWebview: () => T.webview.getCurrentWebview(),

    /* ---------------------------- events --------------------------- */

    listen: (event, handler) => T.event.listen(event, (e) => handler(e.payload)),
    emit: (event, payload) => T.event.emit(event, payload),

    /* ----------------------------- misc ---------------------------- */

    openExternal(url) {
      if (/^https?:/i.test(url)) T.opener.openUrl(url);
    },

    async copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fallback for webviews without clipboard API
      }
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    },
  };
})();
