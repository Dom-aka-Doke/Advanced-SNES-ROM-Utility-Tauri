'use strict';

// Renderer of the main window (UI part of Forms/FormMain.cs)
// Talks to the controller (js/app.js) through window.asru

const $ = (id) => document.getElementById(id);
const api = window.asru;

let state = { loaded: false };
let busyCount = 0;

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function setBusy(busy) {
  busyCount = Math.max(0, busyCount + (busy ? 1 : -1));
  document.body.classList.toggle('busy', busyCount > 0);
}

async function invoke(action, payload) {
  setBusy(true);
  // Give the browser a chance to show the wait cursor before blocking work starts
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

  try {
    const result = await api.invoke(action, payload);
    if (result && result.state) render(result.state);
  } finally {
    setBusy(false);
  }
}

function setText(id, text) {
  const el = $(id);
  el.textContent = text;
  el.title = text && text.length > 0 ? text : '';
}

function setValueIfNotFocused(id, value) {
  const el = $(id);
  if (document.activeElement !== el) el.value = value;
}

function fillSelect(id, items, keepSelection = true) {
  const el = $(id);
  const previous = keepSelection ? el.value : null;
  const signature = JSON.stringify(items);

  if (el.dataset.signature !== signature) {
    el.innerHTML = '';
    for (const item of items) {
      const option = document.createElement('option');
      option.value = String(item.id);
      option.textContent = item.name;
      el.appendChild(option);
    }
    el.dataset.signature = signature;

    if (previous !== null && items.some((i) => String(i.id) === previous)) {
      el.value = previous;
    }
  }
}

function debounce(fn, delay) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  };
  wrapped.flush = (...args) => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      return fn(...args);
    }
    return undefined;
  };
  return wrapped;
}

/* ------------------------------------------------------------------ */
/* Rendering (RefreshLabelsAndButtons)                                  */
/* ------------------------------------------------------------------ */

const BUTTONS = {
  btnSave: 'save',
  btnSaveAs: 'saveAs',
  btnPatch: 'patch',
  btnScan: 'scan',
  btnAddHeader: 'addHeader',
  btnRemoveHeader: 'removeHeader',
  btnSwapBin: 'swapBin',
  btnConvertMapMode: 'convertMapMode',
  btnFixROMSize: 'fixROMSize',
  btnInterleave: 'interleave',
  btnDeinterleave: 'deinterleave',
  btnFixChecksum: 'fixChecksum',
  btnExpand: 'expand',
  btnSplit: 'split',
  btnRemoveRegion: 'removeRegion',
  btnRemoveSRAM: 'removeSRAM',
  btnRemoveSlowROM: 'removeSlowROM',
  btnRemoveOverdump: 'removeOverdump',
  btnHeatmap: 'heatmap',
};

const VALUE_LABELS = {
  lblSMCHeader: 'smcHeader',
  lblMapMode: 'mapMode',
  lblROMType: 'romType',
  lblROMSize: 'romSize',
  lblFileSize: 'fileSize',
  lblROMSpeed: 'romSpeed',
  lblRAM: 'ram',
  lblChecksum: 'checksum',
  lblInvChecksum: 'invChecksum',
  lblCalcChecksum: 'calcChecksum',
  lblCalcInvChecksum: 'calcInvChecksum',
  lblCRC32: 'crc32',
  lblMD5: 'md5',
  lblSHA1: 'sha1',
  lblSHA256: 'sha256',
};

function applyDesign(modern) {
  document.body.classList.toggle('modern', modern);
  document.body.classList.toggle('classic', !modern);
  document.querySelectorAll('.caption[data-modern]').forEach((el) => {
    // Only the caption's text changes; extra elements (f.e. the checksum light) stay
    const text = el.querySelector('.caption-text') || el;
    if (!el.dataset.classic) el.dataset.classic = text.textContent;
    text.textContent = modern ? el.dataset.modern : el.dataset.classic;
  });
}

function render(newState) {
  state = newState;
  applyDesign(!!(state.options && state.options.modern));

  if (state.appTitle) document.title = state.appTitle;

  fillSelect('cmbCountry', state.countries || []);

  if (state.options && state.options.expandFill) $('cmbExpandFill').value = state.options.expandFill;
  $('chkScan').checked = !!(state.options && state.options.scan);

  if (!state.loaded) {
    for (const id of Object.keys(BUTTONS)) $(id).disabled = true;
    $('cmbSRAM').hidden = true;
    $('cmbCompany').disabled = true;
    $('cmbCompany').selectedIndex = -1;
    $('ledChecksum').hidden = true;
    $('lblRAM').hidden = false;
    $('cmbCountry').selectedIndex = -1;
    return;
  }

  // Text boxes
  $('txtROMName').value = state.path;
  $('txtTitle').disabled = false;
  setValueIfNotFocused('txtTitle', state.title);
  if (document.activeElement !== $('txtTitle')) lastTitle = state.title;
  $('txtVersion').disabled = false;
  setValueIfNotFocused('txtVersion', state.version);
  $('txtCode').disabled = !state.gameCodeEnabled;
  setValueIfNotFocused('txtCode', state.gameCode);

  // Combo boxes
  const country = $('cmbCountry');
  country.disabled = !state.countryEnabled;
  if (document.activeElement !== country || country.disabled) {
    country.value = state.country >= 0 ? String(state.country) : '';
    if (state.country < 0) country.selectedIndex = -1;
  }

  fillSelect('cmbExpand', state.expandList, false);
  fillSelect('cmbSplit', state.splitList, false);
  $('cmbExpand').disabled = !state.buttons.expand;
  $('cmbSplit').disabled = !state.buttons.split;

  // Check boxes
  $('cmbExpandFill').disabled = false;
  $('chkScan').disabled = false;

  // Labels
  for (const [id, key] of Object.entries(VALUE_LABELS)) {
    setText(id, state[key] == null ? '' : String(state[key]));
  }
  $('lblRAMLabel').textContent = state.ramLabel;

  // Company
  const cmbCompany = $('cmbCompany');
  fillSelect('cmbCompany', state.companyOptions);
  cmbCompany.disabled = false;
  if (document.activeElement !== cmbCompany) cmbCompany.value = String(state.companyCode);
  cmbCompany.title = `${state.company} – ${state.companyHint}`;

  // (S)RAM size: selectable if the header has a field for it
  const sram = state.sram;
  const cmbSRAM = $('cmbSRAM');
  fillSelect('cmbSRAM', sram.options);
  if (document.activeElement !== cmbSRAM) cmbSRAM.value = String(sram.value);
  cmbSRAM.hidden = !sram.editable;
  cmbSRAM.title = sram.reason;
  $('lblRAM').hidden = sram.editable;
  $('lblRAM').title = sram.editable ? '' : `${state.ram} – ${sram.reason}`;

  document.querySelectorAll('.copy').forEach((el) => el.classList.add('enabled'));

  // Buttons
  for (const [id, key] of Object.entries(BUTTONS)) {
    $(id).disabled = !state.buttons[key];
  }
  $('btnRemoveOverdump').title = state.overdump || '';

  // Checksum status light (modern design)
  const led = $('ledChecksum');
  led.hidden = false;
  led.classList.toggle('ok', state.checksumOk);
  led.classList.toggle('bad', !state.checksumOk);
  led.title = state.checksumOk ? 'Internal checksum is correct' : 'Internal checksum does not match the calculated checksum';
}

/* ------------------------------------------------------------------ */
/* Events                                                               */
/* ------------------------------------------------------------------ */

const simpleButtons = {
  btnSelectROM: 'open',
  btnSave: 'save',
  btnSaveAs: 'saveAs',
  btnAddHeader: 'addHeader',
  btnRemoveHeader: 'removeHeader',
  btnFixChecksum: 'fixChecksum',
  btnFixROMSize: 'fixROMSize',
  btnSwapBin: 'swapBin',
  btnDeinterleave: 'deinterleave',
  btnInterleave: 'interleave',
  btnRemoveRegion: 'removeRegion',
  btnRemoveSRAM: 'removeSRAM',
  btnRemoveSlowROM: 'removeSlowROM',
  btnScan: 'scan',
  btnConvertMapMode: 'convertMapMode',
  btnPatch: 'patch',
  btnRemoveOverdump: 'removeOverdump',
  btnHeatmap: 'heatmap',
};

for (const [id, action] of Object.entries(simpleButtons)) {
  $(id).addEventListener('click', async () => {
    await flushPendingEdits();
    await invoke(action);
  });
}

$('btnExpand').addEventListener('click', async () => {
  await flushPendingEdits();
  await invoke('expand', $('cmbExpand').value);
});

$('btnSplit').addEventListener('click', async () => {
  await flushPendingEdits();
  await invoke('split', $('cmbSplit').value);
});

// Title (TextChanged) – limited to the title's size in bytes (Shift-JIS)
// ASCII and half width katakana need 1 byte, all other characters 2 bytes
function sjisByteLength(text) {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    n += (c < 0x80 || (c >= 0xFF61 && c <= 0xFF9F)) ? 1 : 2;
  }
  return n;
}

const sendTitle = debounce((value) => invoke('setTitle', value), 200);
let lastTitle = '';
$('txtTitle').addEventListener('focus', (e) => { lastTitle = e.target.value; });
$('txtTitle').addEventListener('input', (e) => {
  const el = e.target;
  if (sjisByteLength(el.value.trim()) > (state.titleMaxLength || 21)) {
    // Too long: reject the input (like a max length)
    const pos = Math.max(0, el.selectionStart - (el.value.length - lastTitle.length));
    el.value = lastTitle;
    el.setSelectionRange(pos, pos);
    return;
  }
  lastTitle = el.value;
  sendTitle(el.value);
});
$('txtTitle').addEventListener('blur', (e) => {
  sendTitle.flush(e.target.value);
  if (state.loaded) e.target.value = state.title;
});

// Game code (TextChanged, upper case)
const sendCode = debounce((value) => invoke('setGameCode', value), 200);
$('txtCode').addEventListener('input', (e) => {
  const el = e.target;
  const pos = el.selectionStart;
  el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  el.setSelectionRange(Math.min(pos, el.value.length), Math.min(pos, el.value.length));
  sendCode(el.value);
});
$('txtCode').addEventListener('blur', (e) => {
  sendCode.flush(e.target.value);
  if (state.loaded) e.target.value = state.gameCode;
});

// Version (Leave)
$('txtVersion').addEventListener('blur', async (e) => {
  if (!state.loaded) return;
  await invoke('setVersion', e.target.value);
  e.target.value = state.version;
});
$('txtVersion').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.target.blur();
});

// Country
$('cmbCountry').addEventListener('change', (e) => {
  if (e.target.selectedIndex >= 0) invoke('setCountry', e.target.value);
});

// Company
$('cmbCompany').addEventListener('change', (e) => invoke('setCompany', e.target.value));

// (S)RAM size
$('cmbSRAM').addEventListener('change', (e) => invoke('setSRAMSize', e.target.value));

// Options
$('cmbExpandFill').addEventListener('change', (e) => invoke('setOption', { key: 'expandFill', value: e.target.value }));
$('chkScan').addEventListener('change', (e) => invoke('setOption', { key: 'scan', value: e.target.checked }));

async function flushPendingEdits() {
  await sendTitle.flush($('txtTitle').value);
  await sendCode.flush($('txtCode').value);
}

// Copy checksums to clipboard
let tooltipTimer = null;
document.querySelectorAll('.copy').forEach((el) => {
  el.addEventListener('click', async (e) => {
    if (!state.loaded) return;
    await api.invoke('copy', el.textContent);

    const tip = $('tooltip');
    tip.textContent = 'Checksum has been copied to clipboard!';
    tip.hidden = false;
    const x = Math.min(e.clientX + 12, 542 - tip.offsetWidth - 4);
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${e.clientY + 16}px`;

    clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => { tip.hidden = true; }, 1500);
  });
});

// Drag & drop ROM files: Tauri delivers the paths to the controller (js/app.js),
// here only the overlay is shown while a file is dragged over the window
api.onDragDrop((type) => {
  $('dropOverlay').hidden = !(type === 'enter' || type === 'over');
});

// State pushed by the controller (menu actions, initial load)
api.onState((newState) => render(newState));
api.onBusy((busy) => setBusy(busy));

// Window is about to close: submit pending edits first
api.onFlushEdits(async () => {
  await flushPendingEdits();
  if (state.loaded && document.activeElement === $('txtVersion')) {
    await invoke('setVersion', $('txtVersion').value);
  }
});

invoke('getState');
