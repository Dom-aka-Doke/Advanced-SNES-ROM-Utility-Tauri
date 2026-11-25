'use strict';

// Message boxes inside the window (replacement for Electron's dialog.showMessageBox).
// Same look on Windows, macOS and Linux, any button texts and an optional checkbox.

window.Modal = (function modal() {
  let queue = Promise.resolve();

  /**
   * @param {{message: string, title?: string, type?: string, buttons?: string[],
   *          defaultId?: number, cancelId?: number, checkboxLabel?: string}} options
   * @returns {Promise<{response: number, checkboxChecked: boolean}>}
   */
  function show(options) {
    // One dialog at a time
    const result = queue.then(() => open(options));
    queue = result.catch(() => {});
    return result;
  }

  function open({ message, title = '', type = 'none', buttons = ['OK'], defaultId = 0, cancelId, checkboxLabel }) {
    return new Promise((resolve) => {
      const cancel = cancelId === undefined ? buttons.length - 1 : cancelId;
      const previousFocus = document.activeElement;

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';

      const box = document.createElement('div');
      box.className = `modal-box modal-${type}`;
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');

      if (title) {
        const head = document.createElement('div');
        head.className = 'modal-title';
        head.textContent = title;
        box.appendChild(head);
      }

      const text = document.createElement('div');
      text.className = 'modal-text';
      text.textContent = message;
      box.appendChild(text);

      let checkbox = null;
      if (checkboxLabel) {
        const label = document.createElement('label');
        label.className = 'modal-check';
        checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        label.append(checkbox, ` ${checkboxLabel}`);
        box.appendChild(label);
      }

      const row = document.createElement('div');
      row.className = 'modal-buttons';
      const close = (response) => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (previousFocus && previousFocus.focus) previousFocus.focus();
        resolve({ response, checkboxChecked: !!(checkbox && checkbox.checked) });
      };

      const elements = buttons.map((label, index) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.addEventListener('click', () => close(index));
        row.appendChild(btn);
        return btn;
      });
      box.appendChild(row);

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close(cancel);
        } else if (e.key === 'Tab') {
          // Keep the focus inside the dialog
          const focusable = [checkbox, ...elements].filter(Boolean);
          const i = focusable.indexOf(document.activeElement);
          const next = (i + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
          e.preventDefault();
          focusable[next].focus();
        }
      }
      document.addEventListener('keydown', onKey, true);

      overlay.appendChild(box);
      document.body.appendChild(overlay);
      (elements[defaultId] || elements[0]).focus();
    });
  }

  return {
    show,
    /** Simple message with an OK button */
    message: (message, options = {}) => show({ ...options, message, buttons: ['OK'] }),
  };
})();
