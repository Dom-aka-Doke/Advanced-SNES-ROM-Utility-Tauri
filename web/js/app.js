'use strict';

// Controller of the main window - port of the Electron main process (src/main/main.js).
// The ROM logic runs synchronously in this webview (web/js/core.bundle.js); file access,
// dialogs, menus and windows go through Platform (Tauri).
// Provides window.asru with the same interface as the Electron preload script,
// so renderer.js stays (almost) unchanged.

(function app() {
  const P = window.Platform;
  const R = window.ASRU.require;

  const { SNESROM, ROMLoadError } = R('core/snesrom');
  const F = R('core/functions');
  const C = R('core/converter');
  const { applyPatchFile } = R('core/patcher');
  const Analysis = R('core/analysis');
  const { HeaderOffset, Speed } = R('core/enums');
  const { crc32Hex } = R('core/helper/crc32');
  const CountryRegion = R('core/lists/country');
  const path = R('shims/path');
  const vfs = R('shims/fs').__vfs;
  const version = R('version');

  const APP_NAME = 'Advanced SNES ROM Utility JS';
  const APP_TITLE = `${APP_NAME} v${version.replace(/\.0$/, '')}`;
  const ROM_FILTERS = [
    { name: 'SNES/SFC ROMs (*.smc;*.swc;*.sfc;*.fig)', extensions: ['smc', 'swc', 'sfc', 'fig'] },
    { name: 'All Files (*.*)', extensions: ['*'] },
  ];
  const PATCH_FILTERS = [
    { name: 'Patch File (*.ips;*.ups;*.bps;*.bdf;*.xdelta)', extensions: ['ips', 'ups', 'bps', 'bdf', 'xdelta'] },
  ];
  const MIN_ROM_SIZE = 0x8000;
  const MAX_ROM_SIZE = 16777728;

  /* ------------------------------ settings ------------------------- */

  const EXPAND_FILLS = ['00', 'FF', 'mirror'];
  const DEFAULTS = Object.freeze({
    ExpandFill: '00',
    ScanROMSetting: false,
    SlowROMFixMessage: false,
    ConvertMapModeMessage: false,
    ModernUI: true,
    LastROMFolder: '',
  });

  const settings = {
    values: { ...DEFAULTS },

    async load() {
      try {
        const text = await P.loadSettings();
        if (!text) return;
        const stored = JSON.parse(text);
        for (const key of Object.keys(DEFAULTS)) {
          if (typeof stored[key] === typeof DEFAULTS[key]) this.values[key] = stored[key];
        }
        if (stored.ExpandFill === undefined && stored.MirrorROMSetting === true) this.values.ExpandFill = 'mirror';
        if (!EXPAND_FILLS.includes(this.values.ExpandFill)) this.values.ExpandFill = DEFAULTS.ExpandFill;
      } catch {
        // no (valid) settings yet
      }
    },

    get(key) {
      return this.values[key];
    },

    set(key, value) {
      if (key === 'ExpandFill') {
        this.values[key] = EXPAND_FILLS.includes(value) ? value : DEFAULTS.ExpandFill;
      } else if (typeof DEFAULTS[key] === 'string') {
        this.values[key] = typeof value === 'string' ? value : DEFAULTS[key];
      } else {
        this.values[key] = !!value;
      }
      P.saveSettings(JSON.stringify(this.values, null, 2)).catch(() => {});
    },
  };

  /* ------------------------------ state ---------------------------- */

  let rom = null;
  let savedFileHash = null;
  let scanFlags = { region: false, sram: false, slowrom: false };
  let overdumpCache = { key: null, info: null };
  const listeners = { state: null, busy: null, design: null, flushEdits: null, drop: null };

  const message = (text, options = {}) => window.Modal.show({
    type: options.type || 'none',
    title: options.title || APP_TITLE,
    message: text,
    buttons: ['OK'],
  });

  const ask = (options) => window.Modal.show(options);

  const mbit = (bytes) => {
    const v = bytes / Analysis.MBIT;
    if (v < 1) return `${Math.round(v * 1024)} Kbit`;
    return `${Number.isInteger(v) ? v : v.toFixed(2)} Mbit`;
  };

  /**
   * The core asks for the copier format synchronously (interleave / deinterleave of 20, 24 and
   * 48 Mbit ROMs without header). Run the operation once to find out whether the question comes
   * up (it is asked before anything is changed), ask the user, then run it with the answer.
   */
  async function withCopierChoice(operation) {
    const NEED_CHOICE = {};
    let text = '';

    try {
      return operation((question) => {
        text = question;
        throw NEED_CHOICE;
      });
    } catch (err) {
      if (err !== NEED_CHOICE) throw err;
    }

    const res = await ask({
      type: 'warning',
      title: 'ATTENTION!!!',
      message: text,
      buttons: ['Game Doctor SF', 'Super UFO', 'Standard', 'Cancel'],
      defaultId: 3,
      cancelId: 3,
    });
    const choice = ['gd', 'ufo', 'standard', 'cancel'][res.response];
    return operation(() => choice);
  }

  /** Writes the files the core created (split, swapbin) */
  async function flushCoreWrites() {
    for (const file of vfs.takeWrites()) {
      await P.writeFile(file.path, file.data);
    }
  }

  function expandList() {
    const size = rom.IntCalcFileSize;
    const mirror = settings.get('ExpandFill') === 'mirror';
    const list = [];

    if ((!rom.IsBSROM && size >= 64) || (rom.IsBSROM && size >= 32)) return list;

    if (size < 0.5) list.push({ id: 0.5, name: '512 Kbit (64 kByte) | 27C512' });
    if (size < 1) list.push({ id: 1, name: '1 Mbit (128 kByte) | 27C1001' });
    if (size < 2) list.push({ id: 2, name: '2 Mbit (256 kByte) | 27C2001' });
    if (size < 4) list.push({ id: 4, name: '4 Mbit (512 kByte) | 274001' });
    if (size < 8) list.push({ id: 8, name: '8 Mbit (1 MByte) | 27C801' });
    if (size < 12 && !mirror) list.push({ id: 12, name: '12 Mbit (1,5 MByte)' });
    if (size < 16) list.push({ id: 16, name: '16 Mbit (2 MByte) | 27C160' });
    if (size < 20 && !mirror) list.push({ id: 20, name: '20 Mbit (2,5 MByte)' });
    if (size < 24 && !mirror) list.push({ id: 24, name: '24 Mbit (3 MByte)' });
    if (size < 28 && !mirror) list.push({ id: 28, name: '28 Mbit (3,5 MByte)' });
    if (size < 32) list.push({ id: 32, name: '32 Mbit (4 MByte) | 27C322' });
    // BS-X ROMs (Satellaview memory packs) never exceed 32 Mbit
    if (size < 48 && !rom.IsBSROM) list.push({ id: 48, name: '48 Mbit (6 MByte)' });
    if (size < 64 && !rom.IsBSROM) list.push({ id: 64, name: '64 Mbit (8 MByte)' });

    return list;
  }

  function splitList() {
    const size = rom.IntCalcFileSize;
    const list = [];

    if (size <= 1) return list;

    if (size % 64 === 0 && size > 64) list.push({ id: 64, name: '64 Mbit (8 MByte)' });
    if (size % 32 === 0 && size > 32) list.push({ id: 32, name: '32 Mbit (4 MByte) | 27C322' });
    if (size % 16 === 0 && size > 16) list.push({ id: 16, name: '16 Mbit (2 MByte) | 27C160' });
    if (size % 8 === 0 && size > 8) list.push({ id: 8, name: '8 Mbit (1 MByte) | 27C801' });
    if (size % 4 === 0 && size > 4) list.push({ id: 4, name: '4 Mbit (512 kByte) | 27C4001' });
    if (size % 2 === 0 && size > 2) list.push({ id: 2, name: '2 Mbit (256 kByte) | 27C2001' });
    list.push({ id: 1, name: '1 Mbit (128 kByte) | 27C1001' });

    return list;
  }

  const SRAM_SIZE_NAMES = ['None', '2 kByte (16 Kbit)', '4 kByte (32 Kbit)', '8 kByte (64 Kbit)', '16 kByte (128 Kbit)',
    '32 kByte (256 Kbit)', '64 kByte (512 Kbit)', '128 kByte (1 Mbit)'];

  function sramState(r) {
    const info = r.getSRAMSizeInfo();
    const options = SRAM_SIZE_NAMES.map((name, id) => ({ id, name }));

    if (info.value >= SRAM_SIZE_NAMES.length) {
      options.push({ id: info.value, name: `${Math.pow(2, info.value)} kByte` });
    }

    return { editable: info.editable, value: info.value, reason: info.reason, options };
  }

  function overdumpInfo() {
    const key = `${rom.CRC32Hash}:${rom.SourceROM.length}:${rom.UIntROMHeaderOffset}`;
    if (overdumpCache.key !== key) {
      overdumpCache = { key, info: Analysis.detectOverdump(rom) };
    }
    return overdumpCache.info;
  }

  /** Equivalent of RefreshLabelsAndButtons() */
  function buildState() {
    const base = {
      appTitle: APP_TITLE,
      loaded: !!rom,
      options: {
        expandFill: settings.get('ExpandFill'),
        scan: settings.get('ScanROMSetting'),
        modern: settings.get('ModernUI'),
      },
      countries: CountryRegion.map(([country, region], id) => ({ id, name: `${country} | ${region}` })),
    };

    if (!rom) return base;

    const r = rom;
    const isHiOffset = r.UIntROMHeaderOffset === HeaderOffset.hirom || r.UIntROMHeaderOffset === HeaderOffset.exhirom;
    const isExOffset = r.UIntROMHeaderOffset === HeaderOffset.exlorom || r.UIntROMHeaderOffset === HeaderOffset.exhirom;
    const expand = expandList();
    const split = splitList();
    const overdump = overdumpInfo();

    const buttons = {
      save: true,
      saveAs: true,
      patch: true,
      scan: true,
      addHeader: r.SourceROMSMCHeader == null,
      removeHeader: r.SourceROMSMCHeader != null,
      swapBin: r.SourceROM.length % 1048576 === 0,
      convertMapMode: !r.IsInterleaved && !isExOffset,
      fixROMSize: F.needsInternalROMSizeFix(r),
      interleave: !r.IsInterleaved && isHiOffset,
      deinterleave: r.IsInterleaved,
      fixChecksum: !r.IsInterleaved && !F.bytesEqual(r.ByteArrayChecksum, r.ByteArrayCalcChecksum),
      expand: expand.length > 0,
      split: split.length > 0,
      removeRegion: scanFlags.region,
      removeSRAM: scanFlags.sram,
      removeSlowROM: scanFlags.slowrom,
      removeOverdump: overdump.overdump,
      heatmap: true,
    };

    let ramLabel = '(S)RAM';
    if (r.ByteSRAMSize > 0x00) ramLabel = 'SRAM';
    else if (r.ByteExRAMSize > 0x00) ramLabel = 'RAM';

    return {
      ...base,
      path: r.ROMFullPath,
      title: r.StringTitle.trim(),
      titleMaxLength: r.ByteArrayTitle.length,
      company: r.StringCompany,
      country: r.ByteCountry < CountryRegion.length ? r.ByteCountry : -1,
      countryEnabled: !r.IsBSROM,
      version: r.StringVersion,
      gameCode: r.StringGameCode.trim(),
      gameCodeEnabled: r.StringGameCode.trim() !== 'N/A',
      smcHeader: r.StringSMCHeader,
      mapMode: r.StringMapMode,
      romType: r.StringROMType,
      romSize: r.StringROMSize,
      fileSize: `${F.formatMbit(r.IntCalcFileSize)} (${F.formatMByte(r.IntCalcFileSize)})`,
      romSpeed: r.StringROMSpeed,
      ramLabel,
      ram: r.StringRAMSize,
      sram: sramState(r),
      companyCode: r.IntCompany,
      companyOptions: r.getCompanyOptions().map((o) => ({ id: o.code, name: `${o.name} [${o.notation}]` })),
      companyHint: r.hasMakerCode
        ? 'Extended header: maker code at $FFB0 (2 characters)'
        : 'Old header: licensee byte at $FFDA (only companies with a 1 byte code available)',
      checksum: r.checksumHex,
      checksumOk: r.checksumHex === r.calcChecksumHex && r.invChecksumHex === r.calcInvChecksumHex,
      invChecksum: r.invChecksumHex,
      calcChecksum: r.calcChecksumHex,
      calcInvChecksum: r.calcInvChecksumHex,
      crc32: r.CRC32Hash,
      md5: r.MD5Hash,
      sha1: r.SHA1Hash,
      sha256: r.SHA256Hash,
      expandList: expand,
      splitList: split,
      buttons,
      overdump: overdump.overdump
        ? `${overdump.type === 'mirror' ? 'Mirrored' : 'Padded'} data: ${mbit(overdump.fileSize)} -> ${mbit(overdump.realSize)}`
        : (overdump.reason || 'No overdump found'),
    };
  }

  function pushState() {
    if (listeners.state) listeners.state(buildState());
    notifyHeatmap();
  }

  function notifyHeatmap() {
    P.emit('rom-changed').catch(() => {});
  }

  function scanCopyProtections() {
    scanFlags.region = F.removeRegionChecks(rom, false);
    scanFlags.slowrom = rom.ByteROMSpeed === Speed.fast ? F.removeSlowROMChecks(rom, false) : false;
    scanFlags.sram = F.removeSRAMChecks(rom, false);
  }

  /* ------------------------------ files ---------------------------- */

  async function loadROM(filePath) {
    let newROM;
    let bytes = null;

    try {
      const info = await P.fileInfo(filePath);
      if (!info.exists || !info.isFile) throw new ROMLoadError(`File not found: ${filePath}`);

      // Only read files the core accepts; it checks the size first
      if (info.size >= MIN_ROM_SIZE && info.size <= MAX_ROM_SIZE) {
        bytes = await P.readFile(filePath);
        vfs.put(filePath, bytes);
      } else {
        vfs.putStat(filePath, info.size);
      }

      newROM = new SNESROM(filePath);
    } catch (err) {
      await message(err instanceof ROMLoadError ? err.message : `Unable to load ROM!\n\n${err.message || err}`, { type: 'error' });
      return;
    } finally {
      vfs.drop(filePath);
    }

    rom = newROM;
    savedFileHash = crc32Hex(bytes);
    scanFlags = { region: false, sram: false, slowrom: false };
    settings.set('LastROMFolder', path.dirname(filePath));

    if (settings.get('ScanROMSetting')) scanCopyProtections();
  }

  /** Folder of the last opened ROM; the default folder if it does not exist anymore */
  async function openDialogFolder() {
    const last = settings.get('LastROMFolder');
    if (last) {
      try {
        if ((await P.fileInfo(last)).isDir) return last;
      } catch {
        // drive not available
      }
    }
    return (await P.defaultFolder()) || undefined;
  }

  async function openDialog() {
    const file = await P.openDialog({ defaultPath: await openDialogFolder(), filters: ROM_FILTERS });
    if (file) await loadROM(file);
  }

  async function writeROM(filePath) {
    const data = rom.getSaveData();
    await P.writeFile(filePath, data);
    savedFileHash = crc32Hex(data);
  }

  function isDirty() {
    if (!rom || savedFileHash == null) return false;
    return crc32Hex(rom.getSaveData()) !== savedFileHash;
  }

  /* ------------------------------ actions -------------------------- */

  const actions = {
    getState: async () => {},

    open: openDialog,

    openPath: async (filePath) => {
      if (filePath) await loadROM(filePath);
    },

    scan: async () => { if (rom) scanCopyProtections(); },

    addHeader: async () => F.addHeader(rom),
    removeHeader: async () => F.removeHeader(rom),
    fixChecksum: async () => F.fixChecksum(rom),
    fixROMSize: async () => F.fixInternalROMSize(rom),

    expand: async (size) => {
      const value = Number(size);
      if (!expandList().some((e) => e.id === value)) return;
      C.expand(rom, value, settings.get('ExpandFill'));
    },

    split: async (size) => {
      const value = Number(size);
      if (!(value >= 1)) return;
      const files = C.split(rom, value);
      await flushCoreWrites();
      await message(`ROM successfully splitted!\n\nFile(s) saved to:\n${files.map((f) => `'${f}'`).join('\n')}\n\nIn case there was a header, it has been removed!`);
    },

    swapBin: async () => {
      C.swapBin(rom);
      await flushCoreWrites();
      await message(`ROM successfully swapped!\n\nFile(s) saved to: '${rom.ROMFolder}'\n\nIn case there was a header, it has been removed!`);
    },

    deinterleave: async () => { await withCopierChoice((choose) => C.deinterleave(rom, choose)); },
    interleave: async () => { await withCopierChoice((choose) => C.interleave(rom, choose)); },

    removeRegion: async () => {
      F.removeRegionChecks(rom);
      scanFlags.region = false;
    },

    removeSRAM: async () => {
      F.removeSRAMChecks(rom);
      scanFlags.sram = false;
    },

    removeSlowROM: async () => {
      if (!settings.get('SlowROMFixMessage')) {
        const res = await ask({
          type: 'info',
          title: 'ATTENTION!!!',
          message:
            'Removing SlowROM checks from a FastROM will force this ROM into\nSlowROM mode.\n\n' +
            'This might cause some slow downs while playing.\n\n' +
            "It isn't really recommended or necessary to do this anymore.\n\n" +
            'This only makes sense, if you want to play this ROM on a device slower\nthan 120ns.\n\n' +
            'Do you want to proceed anyway?',
          buttons: ['Yes', 'No'],
          defaultId: 0,
          cancelId: 1,
          checkboxLabel: "Don't show this message again",
        });

        if (res.checkboxChecked) settings.set('SlowROMFixMessage', true);
        if (res.response !== 0) return;
      }

      F.removeSlowROMChecks(rom);
      scanFlags.slowrom = false;
    },

    removeOverdump: async () => {
      const info = overdumpInfo();
      if (!info.overdump) {
        await message(info.reason || 'No overdump found.');
        return;
      }

      const how = info.type === 'mirror'
        ? `The last ${mbit(info.fileSize - info.realSize)} of the ROM are a mirror of the data before.`
        : `The ROM is larger than its internal size and the last ${mbit(info.fileSize - info.realSize)} only contain 0x${info.fill.toString(16).toUpperCase().padStart(2, '0')}.`;

      const res = await ask({
        type: 'question',
        title: 'Overdump detected',
        message: `${how}\n\nFile size: ${mbit(info.fileSize)}\nReal ROM size: ${mbit(info.realSize)}\n\nDo you want to remove the overdump?`,
        buttons: ['Yes', 'No'],
        defaultId: 0,
        cancelId: 1,
      });
      if (res.response !== 0) return;

      Analysis.removeOverdump(rom);
      await message(`Overdump has been removed. The ROM now has ${mbit(rom.SourceROM.length)}.` +
        (F.needsInternalROMSizeFix(rom) ? '\n\nThe internal ROM size does not match anymore - use "Fix Internal ROM Size".' : ''));
    },

    heatmap: async () => openChildWindow('heatmap'),

    convertMapMode: async () => {
      if (!settings.get('ConvertMapModeMessage')) {
        const res = await ask({
          type: 'info',
          title: 'ATTENTION!!!',
          message:
            'Converting map mode from LoROM <-> HiROM might not work in\nevery case.\n\n' +
            'This will only rearrange ROM banks to fit the right memory format.\n\n' +
            'If your ROM uses (S)RAM or enhancement chips, you have to do some\nmanual work after converting.\n\n' +
            'Converting HiROM to LoROM only works, if the ROM was designed to\nbe convertible.\n\n' +
            'You should always test your ROM in detail after doing this operation.\n\n' +
            'Do you want to proceed anyway?',
          buttons: ['Yes', 'No'],
          defaultId: 0,
          cancelId: 1,
          checkboxLabel: "Don't show this message again",
        });

        if (res.checkboxChecked) settings.set('ConvertMapModeMessage', true);
        if (res.response !== 0) return;
      }

      if (!C.convertMapMode(rom)) {
        await message(`Converting map mode "${rom.StringMapMode}" is not supported.`, { type: 'warning' });
      }
    },

    patch: async () => {
      // Patches usually lie next to the ROM
      const file = await P.openDialog({ defaultPath: rom.ROMFolder, filters: PATCH_FILTERS });
      if (!file) return;

      let result;
      try {
        vfs.put(file, await P.readFile(file));
        result = applyPatchFile(rom, file);
      } finally {
        vfs.drop(file);
      }

      if (result.ok) {
        await message('ROM has successfully been patched!');
      } else {
        await message('Could not apply patch! Please check if your patch is valid for your ROM.' +
          (result.message ? `\n\n${result.message}` : ''), { type: 'error' });
      }
    },

    save: async () => {
      await writeROM(rom.ROMFullPath);
      await message('ROM file has successfully been saved!');
    },

    saveAs: async () => {
      const file = await P.saveDialog({ defaultPath: rom.ROMFullPath, filters: ROM_FILTERS });
      if (!file) return;

      await writeROM(file);
      await message(`ROM file has successfully been saved to: ${file}`);
      await loadROM(file);
    },

    setTitle: async (text) => {
      if (rom.StringTitle.trim() !== String(text).trim()) {
        rom.setTitle(String(text), rom.ByteArrayTitle.length);
      }
    },

    setVersion: async (text) => {
      const value = String(text).trim();
      if (rom.StringVersion === '' || rom.StringVersion.trim() === value) return;

      const pattern = /^([1]\.)([0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|2[5][0-5])$/;

      if (pattern.test(value)) {
        rom.setVersion(parseInt(value.split('.')[1], 10));
      } else {
        await message('Enter version number between 1.0 and 1.255', { type: 'warning' });
      }
    },

    setGameCode: async (text) => {
      const value = String(text).toUpperCase();
      if (rom.StringGameCode.trim() !== value.trim()) rom.setGameCode(value);
    },

    setCountry: async (index) => {
      const value = Number(index);
      if (rom.IsBSROM || !(value >= 0)) return;
      if (rom.ByteCountry !== value) rom.setCountryRegion(value);
    },

    setCompany: async (value) => {
      const code = Number(value);
      if (!Number.isInteger(code) || code === rom.IntCompany) return;

      if (!rom.setCompany(code)) {
        await message('This company code cannot be stored in the header of this ROM.', { type: 'warning' });
      }
    },

    setSRAMSize: async (value) => {
      const size = Number(value);
      const info = rom.getSRAMSizeInfo();
      if (!info.editable || info.value === size) return;

      if (!rom.setSRAMSize(size)) {
        await message('The SRAM size of this ROM cannot be changed.', { type: 'warning' });
        return;
      }

      // SRAM checks depend on the SRAM size
      if (settings.get('ScanROMSetting')) scanCopyProtections();
    },

    setOption: async ({ key, value }) => {
      if (key === 'expandFill') settings.set('ExpandFill', value);
      if (key === 'scan') settings.set('ScanROMSetting', value);
      if (key === 'modern') await setDesign(value);
    },

    copy: async (text) => P.copyText(String(text || '')),
  };

  const NO_ROM_NEEDED = new Set(['getState', 'open', 'openPath', 'setOption', 'copy']);

  async function invoke(name, payload) {
    if (!Object.prototype.hasOwnProperty.call(actions, name)) return { state: buildState() };
    if (!NO_ROM_NEEDED.has(name) && !rom) return { state: buildState() };

    try {
      await actions[name](payload);
      if (name !== 'getState') notifyHeatmap();
    } catch (err) {
      vfs.takeWrites();
      await message(`An unexpected error occurred!\n\n${err && err.stack ? err.stack : err}`, { type: 'error' });
    }

    return { state: buildState() };
  }

  /* ------------------------------ windows -------------------------- */

  const CHILD_WINDOWS = {
    manual: { width: 706, height: 587, resizable: true, title: () => `Manual of the ${APP_TITLE}` },
    about: { width: 452, height: 346, resizable: false, title: () => `About the ${APP_TITLE}` },
    heatmap: { width: 780, height: 640, resizable: true, title: () => `ROM Heatmap - ${APP_TITLE}` },
  };

  async function openChildWindow(kind) {
    const w = CHILD_WINDOWS[kind];
    const query = new URLSearchParams({ version, title: APP_TITLE, modern: settings.get('ModernUI') ? '1' : '0' });
    try {
      await P.openWindow(kind, { title: w.title(), width: w.width, height: w.height, resizable: w.resizable, query: query.toString() });
    } catch (err) {
      await message(`Unable to open window!\n\n${err}`, { type: 'error' });
    }
  }

  /** Data for the heatmap window (requested by an event, answered by an event) */
  function heatmapData(bankSize) {
    if (!rom) return null;
    const size = Number(bankSize) === 0x8000 || Number(bankSize) === 0x10000 ? Number(bankSize) : undefined;
    return {
      name: path.basename(rom.ROMFullPath),
      defaultBankSize: Analysis.defaultBankSize(rom),
      interleaved: rom.IsInterleaved,
      overdump: overdumpInfo(),
      ...Analysis.analyzeBanks(rom, size),
    };
  }

  async function setDesign(modern) {
    settings.set('ModernUI', !!modern);
    P.setDesignMenu(!!modern).catch(() => {});
    pushState();
    P.emit('design', !!modern).catch(() => {});
  }

  async function resetOptions() {
    const res = await ask({
      type: 'warning',
      title: 'Attention!',
      message: 'This will reset all your saved settings and\nrestore all your suppressed dialog messages.\n\nDo you want to proceed?',
      buttons: ['Yes', 'No'],
      defaultId: 1,
      cancelId: 1,
    });

    if (res.response !== 0) return;

    settings.set('ExpandFill', '00');
    settings.set('ScanROMSetting', false);
    settings.set('SlowROMFixMessage', false);
    settings.set('ConvertMapModeMessage', false);
    pushState();

    await message('All settings have been reset successfully!', { title: 'Success!' });
  }

  /** Runs an action triggered outside the renderer (menu, drag & drop) with busy cursor */
  async function runExternal(fn) {
    if (listeners.busy) listeners.busy(true);
    try {
      await fn();
    } catch (err) {
      await message(`An unexpected error occurred!\n\n${err && err.stack ? err.stack : err}`, { type: 'error' });
    } finally {
      pushState();
      if (listeners.busy) listeners.busy(false);
    }
  }

  const MENU = {
    open: () => runExternal(openDialog),
    exit: () => P.currentWindow().close(),
    modern: () => setDesign(true),
    classic: () => setDesign(false),
    'toggle-design': () => setDesign(!settings.get('ModernUI')),
    reset: () => resetOptions(),
    manual: () => openChildWindow('manual'),
    about: () => openChildWindow('about'),
  };

  /* ------------------------------ closing -------------------------- */

  /** FormMain_FormClosing: ask to save unsaved changes. Returns false to keep the window open. */
  async function confirmClose() {
    if (listeners.flushEdits) {
      try {
        await listeners.flushEdits();
      } catch {
        // close anyway
      }
    }

    if (!isDirty()) return true;

    const res = await ask({
      type: 'question',
      title: 'Attention!',
      message: 'Do you want to save your progress before closing?',
      buttons: ['Yes', 'No', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });

    if (res.response === 2) return false;
    if (res.response === 1) return true;

    try {
      await writeROM(rom.ROMFullPath);
      await message(`ROM file has successfully been saved to: ${rom.ROMFullPath}`);
      return true;
    } catch (err) {
      await message(`Unable to save ROM!\n\n${err}`, { type: 'error' });
      return false;
    }
  }

  /* ------------------------------ start ---------------------------- */

  async function start() {
    await settings.load();
    P.setDesignMenu(settings.get('ModernUI')).catch(() => {});

    P.listen('menu', (id) => {
      if (MENU[id]) MENU[id]();
    });

    P.listen('heatmap:get', ({ id, bankSize }) => {
      let data = null;
      try {
        data = heatmapData(bankSize);
      } catch {
        // window shows "no data"
      }
      P.emit('heatmap:data', { id, data });
    });

    const win = P.currentWindow();
    let closing = false;
    win.onCloseRequested(async (event) => {
      if (closing) return;
      event.preventDefault();
      if (await confirmClose()) {
        closing = true;
        await win.destroy();
      }
    });

    // Drag & drop of ROM files (paths come from Tauri, the webview gets no file objects)
    P.currentWebview().onDragDropEvent((event) => {
      const { type } = event.payload;
      if (listeners.drop) listeners.drop(type);
      if (type === 'drop' && event.payload.paths && event.payload.paths.length > 0) {
        runExternal(() => loadROM(event.payload.paths[0]));
      }
    });

    const file = await P.startupFile();
    if (file) await loadROM(file);
    pushState();
    await win.show();
    // The menu bar (Windows / Linux) must not cut off the bottom of the window
    await P.fitContent(542, 571).catch(() => {});
  }

  /* ------------------------------ bridge --------------------------- */

  window.asru = {
    invoke,
    onState: (cb) => { listeners.state = cb; },
    onBusy: (cb) => { listeners.busy = cb; },
    onDesign: (cb) => { listeners.design = cb; },
    onFlushEdits: (cb) => { listeners.flushEdits = cb; },
    /** Drag & drop state: 'enter' | 'over' | 'drop' | 'leave' */
    onDragDrop: (cb) => { listeners.drop = cb; },
    openExternal: (url) => P.openExternal(url),
  };

  // Start after renderer.js has registered its listeners
  window.addEventListener('DOMContentLoaded', () => {
    start().catch((err) => message(`Unable to start!\n\n${err && err.stack ? err.stack : err}`, { type: 'error' }));
  });
})();
