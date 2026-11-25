'use strict';

// ROM Heatmap: shows the ROM split into banks (32 kByte LoROM / 64 kByte HiROM)
// and highlights identical (duplicated) and empty banks.

(function heatmap() {
  const $ = (id) => document.getElementById(id);
  const api = window.asru;

  const appTitle = new URLSearchParams(window.location.search).get('title');
  if (appTitle) document.title = `ROM Heatmap - ${appTitle}`;

  // Sequential ramp (blue 100 -> 700) for the entropy view
  const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5',
    '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];

  const COLORS = {
    unique: 'var(--cat-unique)',
    duplicate: 'var(--cat-duplicate)',
    empty: 'var(--cat-empty)',
  };
  const LIGHT_TEXT = new Set(['unique']);

  let data = null;
  let mode = 'dup';
  let bankSizeChoice = 'auto';

  const hex = (n, len = 2) => n.toString(16).toUpperCase().padStart(len, '0');
  const kb = (bytes) => `${bytes / 1024} kByte`;
  const mbit = (bytes) => {
    const v = bytes / 0x20000;
    if (v < 1) return `${Math.round(v * 1024)} Kbit`;
    return `${Number.isInteger(v) ? v : v.toFixed(2)} Mbit`;
  };

  function rampColor(entropy) {
    const i = Math.min(RAMP.length - 1, Math.max(0, Math.round((entropy / 8) * (RAMP.length - 1))));
    return { color: RAMP[i], dark: i >= 7 };
  }

  function bankStatus(b) {
    if (b.fill !== null) return 'empty';
    if (b.group !== null) return 'duplicate';
    return 'unique';
  }

  function statusText(b) {
    if (b.fill !== null) return `Empty (filled with 0x${hex(b.fill)})`;
    if (b.group !== null) {
      const members = data.groups[b.group].banks.filter((m) => m !== b.index).map((m) => hex(m)).join(', ');
      return b.duplicateOf === null
        ? `Original – identical to bank(s) ${members}`
        : `Duplicate of bank ${hex(b.duplicateOf)}`;
    }
    return 'Unique data';
  }

  /* ------------------------------ rendering ------------------------------ */

  function renderLegend() {
    const legend = $('legend');
    if (mode === 'dup') {
      legend.innerHTML = [
        ['unique', 'Unique'],
        ['duplicate', 'Duplicate (identical bank)'],
        ['empty', 'Empty (only 0x00 or 0xFF)'],
      ].map(([k, label]) => `<span class="item"><span class="swatch" style="background:${COLORS[k]}"></span>${label}</span>`).join('') +
        '<span class="item"><span class="swatch ring"></span>Internal header</span>';
    } else {
      legend.innerHTML = `<span class="item">Entropy (bits per byte)</span>
        <span class="item">0 <span class="swatch ramp" style="background:linear-gradient(90deg, ${RAMP.join(', ')})"></span> 8</span>
        <span class="item"><span class="swatch ring"></span>Internal header</span>
        <span class="item muted">Low = empty / repetitive, high = compressed / random data</span>`;
    }
  }

  function renderGrid() {
    const grid = $('grid');
    grid.innerHTML = '';
    const perRow = 16;

    data.banks.forEach((b) => {
      if (b.index % perRow === 0) {
        const label = document.createElement('div');
        label.className = 'row-label';
        label.textContent = `$${hex(b.offset, 6)}`;
        grid.appendChild(label);
      }

      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.index = String(b.index);
      cell.textContent = hex(b.index);
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', `Bank ${hex(b.index)}: ${statusText(b)}`);

      if (mode === 'dup') {
        const status = bankStatus(b);
        cell.style.background = COLORS[status];
        if (LIGHT_TEXT.has(status)) cell.classList.add('light-text');
      } else {
        const { color, dark } = rampColor(b.entropy);
        cell.style.background = color;
        if (dark) cell.classList.add('light-text');
      }

      if (b.header) cell.classList.add('header');
      if (b.length < data.bankSize) cell.classList.add('partial');

      grid.appendChild(cell);
    });
  }

  function renderGroups() {
    const el = $('groups');
    if (!data.groups.length) {
      el.textContent = 'No identical banks found.';
      return;
    }

    const list = document.createElement('ul');
    data.groups.forEach((g) => {
      const li = document.createElement('li');
      li.dataset.group = String(g.id);
      li.textContent = `${g.banks.length}× identical: banks ${g.banks.map((i) => hex(i)).join(', ')}` +
        `  (offsets ${g.banks.map((i) => `$${hex(data.banks[i].offset, 6)}`).join(', ')})`;
      list.appendChild(li);
    });
    el.innerHTML = '';
    el.appendChild(list);
  }

  function renderSummary() {
    $('romName').textContent = data.name;
    $('romInfo').textContent = `${data.mapMode} · ${mbit(data.romSize)} · ${data.summary.banks} ${data.summary.banks === 1 ? 'bank' : 'banks'} of ${kb(data.bankSize)}` +
      (data.interleaved ? ' · interleaved' : '');
    $('tBanks').textContent = data.summary.banks;
    $('tUnique').textContent = data.summary.unique;
    $('tDup').textContent = data.summary.duplicates;
    $('tDupSub').textContent = data.summary.groups
      ? `In duplicate groups (${data.summary.groups} groups, ${data.summary.copies} copies)`
      : 'In duplicate groups';
    $('tEmpty').textContent = data.summary.empty;

    const od = data.overdump;
    let text = 'None found';
    if (!od.supported) text = od.reason;
    else if (od.overdump) text = `${od.type === 'mirror' ? 'Mirrored' : 'Padded'}: ${mbit(od.fileSize)} → ${mbit(od.realSize)}`;
    $('tOverdump').textContent = text;
    $('tOverdump').title = text;

    const auto = $('bankSize').options[0];
    auto.textContent = `Auto (${kb(data.defaultBankSize)})`;
  }

  function render() {
    if (!data) return;
    renderSummary();
    renderLegend();
    renderGrid();
    renderGroups();
  }

  async function load() {
    const size = bankSizeChoice === 'auto' ? undefined : Number(bankSizeChoice);
    data = await api.getHeatmap(size);
    if (!data) {
      $('romName').textContent = 'No ROM loaded';
      $('grid').innerHTML = '';
      return;
    }
    render();
  }

  /* ------------------------------ interaction ------------------------------ */

  function highlight(indices) {
    document.querySelectorAll('.cell.highlight').forEach((c) => c.classList.remove('highlight'));
    for (const i of indices) {
      const c = document.querySelector(`.cell[data-index="${i}"]`);
      if (c) c.classList.add('highlight');
    }
  }

  const tip = $('tip');

  $('grid').addEventListener('mousemove', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell || !data) {
      tip.hidden = true;
      highlight([]);
      return;
    }

    const b = data.banks[Number(cell.dataset.index)];
    tip.innerHTML =
      `<b>Bank ${hex(b.index)}</b><br>` +
      `<span class="k">File offset:</span> $${hex(b.offset, 6)} – $${hex(b.offset + b.length - 1, 6)}<br>` +
      (b.snes ? `<span class="k">SNES address:</span> ${b.snes}<br>` : '') +
      `<span class="k">Status:</span> ${statusText(b)}<br>` +
      `<span class="k">Entropy:</span> ${b.entropy.toFixed(2)} bits/byte` +
      (b.header ? '<br><b>Contains the internal header</b>' : '') +
      (b.length < data.bankSize ? `<br><span class="k">Partial bank (${b.length} bytes)</span>` : '');
    tip.hidden = false;

    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 6);
    const y = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 6);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;

    highlight(b.group !== null ? data.groups[b.group].banks : [b.index]);
  });

  $('grid').addEventListener('mouseleave', () => {
    tip.hidden = true;
    highlight([]);
  });

  $('groups').addEventListener('mouseover', (e) => {
    const li = e.target.closest('li');
    if (li && data) highlight(data.groups[Number(li.dataset.group)].banks);
  });

  $('groups').addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li || !data) return;
    const first = data.groups[Number(li.dataset.group)].banks[0];
    const c = document.querySelector(`.cell[data-index="${first}"]`);
    if (c) c.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });

  $('bankSize').addEventListener('change', (e) => {
    bankSizeChoice = e.target.value;
    load();
  });

  $('modeDup').addEventListener('click', () => {
    mode = 'dup';
    $('modeDup').classList.add('active');
    $('modeEntropy').classList.remove('active');
    render();
  });

  $('modeEntropy').addEventListener('click', () => {
    mode = 'entropy';
    $('modeEntropy').classList.add('active');
    $('modeDup').classList.remove('active');
    render();
  });

  $('btnClose').addEventListener('click', () => api.closeWindow());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.closeWindow();
  });

  // Reload when the ROM in the main window changes
  api.onRomChanged(() => load());

  load();
})();
