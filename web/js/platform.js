'use strict';

// Thin wrapper around the Tauri API (window.__TAURI__, see "withGlobalTauri").
// Everything that needs the operating system goes through here.

window.Platform = (function platform() {
  const T = window.__TAURI__;
  const invoke = (cmd, args, options) => T.core.invoke(cmd, args, options);

  /**
   * Raw request body: 4 bytes length (little endian) + JSON parameters + data.
   * Parameters travel in the body because the IPC protocol rejects own header fields.
   */
  function framed(params, data) {
    const json = new TextEncoder().encode(JSON.stringify(params));
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const body = new Uint8Array(4 + json.length + bytes.length);
    new DataView(body.buffer).setUint32(0, json.length, true);
    body.set(json, 4);
    body.set(bytes, 4 + json.length);
    return body;
  }

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
    writeFile: (path, data) => invoke('write_file', framed({ path }, data)),

    startupFile: () => invoke('startup_file'),

    /** Writes the ROM to a temporary copy and starts the emulator with it */
    runEmulator: (emulator, args, name, data) => invoke('run_emulator', framed({ emulator, args, name }, data)),

    /** "windows", "macos" or "linux" */
    os: /Windows/i.test(navigator.userAgent) ? 'windows' : /Mac/i.test(navigator.userAgent) ? 'macos' : 'linux',
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
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

      // Correct the window by the difference between wanted and real content size;
      // repeated, because the menu bar may only be counted after the first resize
      for (let attempt = 0; attempt < 3; attempt++) {
        await frame();
        const diffW = width - window.innerWidth;
        const diffH = height - window.innerHeight;
        if (window.innerHeight <= 0 || (Math.abs(diffW) < 1 && Math.abs(diffH) < 1)) return;

        const scale = await win.scaleFactor();
        const inner = (await win.innerSize()).toLogical(scale);
        await win.setSize(new T.dpi.LogicalSize(inner.width + diffW, inner.height + diffH));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    /** Check marks / enabled state of the menu (design, scan, run in emulator) */
    setMenuState: ({ modern, scan, romLoaded }) => invoke('set_menu_state', { modern, scan, romLoaded }),
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
