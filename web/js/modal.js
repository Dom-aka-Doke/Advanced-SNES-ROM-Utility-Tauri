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

  /**
   * Dialog for the emulator of "Run in Emulator"
   * @param {{path: string, args: string, defaultArgs: string, browse: (current: string) => Promise<string|null>,
   *          validate: (path: string) => Promise<string|null>}} options
   * @returns {Promise<{ok: boolean, path: string, args: string}>}
   */
  function emulator(options) {
    const result = queue.then(() => openEmulator(options));
    queue = result.catch(() => {});
    return result;
  }

  function openEmulator({ path, args, defaultArgs, browse, validate }) {
    return new Promise((resolve) => {
      const previousFocus = document.activeElement;
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';

      const box = document.createElement('div');
      box.className = 'modal-box modal-form';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');

      const head = document.createElement('div');
      head.className = 'modal-title';
      head.textContent = 'Set Emulator';
      box.appendChild(head);

      const body = document.createElement('div');
      body.className = 'modal-text modal-fields';

      const field = (labelText, value) => {
        const label = document.createElement('label');
        label.textContent = labelText;
        const input = document.createElement('input');
        input.spellcheck = false;
        input.value = value;
        label.appendChild(input);
        return { label, input };
      };

      const program = field('Emulator (program file)', path || '');
      const browseBtn = document.createElement('button');
      browseBtn.type = 'button';
      browseBtn.textContent = 'Browse...';
      const pathRow = document.createElement('div');
      pathRow.className = 'modal-path';
      pathRow.append(program.input, browseBtn);
      program.label.appendChild(pathRow);

      const argsField = field('Arguments', args || defaultArgs);

      const hint = document.createElement('div');
      hint.className = 'modal-hint';
      hint.textContent = '%ROM% is replaced by the path of the ROM. Example for RetroArch:\n-L cores/snes9x_libretro.dll "%ROM%"';

      const error = document.createElement('div');
      error.className = 'modal-error';

      body.append(program.label, argsField.label, hint, error);
      box.appendChild(body);

      const row = document.createElement('div');
      row.className = 'modal-buttons';
      const button = (text) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = text;
        return btn;
      };
      const removeBtn = button('Remove');
      removeBtn.className = 'modal-left';
      const okBtn = button('OK');
      const cancelBtn = button('Cancel');
      row.append(removeBtn, okBtn, cancelBtn);
      box.appendChild(row);

      const close = (ok) => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (previousFocus && previousFocus.focus) previousFocus.focus();
        resolve({ ok, path: program.input.value.trim().replace(/^"(.*)"$/, '$1'), args: argsField.input.value.trim() || defaultArgs });
      };

      browseBtn.addEventListener('click', async () => {
        const chosen = await browse(program.input.value.trim());
        if (chosen) program.input.value = chosen;
      });
      removeBtn.addEventListener('click', () => {
        program.input.value = '';
        argsField.input.value = defaultArgs;
        error.textContent = '';
      });
      okBtn.addEventListener('click', async () => {
        const problem = await validate(program.input.value.trim().replace(/^"(.*)"$/, '$1'));
        if (problem) {
          error.textContent = problem;
          return;
        }
        close(true);
      });
      cancelBtn.addEventListener('click', () => close(false));

      const focusable = [program.input, browseBtn, argsField.input, removeBtn, okBtn, cancelBtn];
      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close(false);
        } else if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
          e.preventDefault();
          okBtn.click();
        } else if (e.key === 'Tab') {
          const i = focusable.indexOf(document.activeElement);
          const next = (i + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
          e.preventDefault();
          focusable[next].focus();
        }
      }
      document.addEventListener('keydown', onKey, true);

      overlay.appendChild(box);
      document.body.appendChild(overlay);
      program.input.focus();
    });
  }

  return {
    show,
    emulator,
    /** Simple message with an OK button */
    message: (message, options = {}) => show({ ...options, message, buttons: ['OK'] }),
  };
})();
