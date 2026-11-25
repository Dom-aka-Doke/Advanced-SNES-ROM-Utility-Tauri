'use strict';

// Port of Models/SNESROM.cs

const fs = require('fs');
const path = require('path');
const { HeaderOffset, HeaderValue, MapMode, Speed, getMapModeDescription, getSpeedDescription } = require('./enums');
const F = require('./functions');
const sjis = require('./helper/shiftjis');
const CC = require('./helper/companycode');

const GameCode = {
  sanitize: (text) => String(text).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4),
};
const CountryRegion = require('./lists/country');
const Company = require('./lists/company');

const MIN_ROM_SIZE = 0x8000;   // 256 Kbit: one LoROM bank, the smallest ROM that holds a header at $7FC0
const MAX_ROM_SIZE = 16777728; // 128 Mbit incl. 512 byte header

class ROMLoadError extends Error {}

// Games that are detected as DSP-4 but actually are DSP-1
const FALSE_DSP1_GAMES = [
  'Ballz                ',
  'Lock On              ',
  'INDY CAR CHALLENGE   ',
  'SUPER AIR DIVER      ',
  'SUPER AIRDIVER2      ',
  'SUZUKA 8Hours        ',
  'ｴｰｽｦﾈﾗｴ!             ', // Ace o Nerae!
  'ｿｳｺｳｷﾍｲ ﾎﾞﾄﾑｽﾞ       ', // Soukou Kihei Votoms - The Battling Road
];

// Games that are detected as GSU-1 but actually are GSU-2
const FALSE_GSU2_GAMES = ['STARFOX2             '];

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');

class SNESROM {
  /**
   * @param {string} romPath path of the ROM file
   */
  constructor(romPath) {
    this.ROMName = null;
    this.ROMFullPath = null;
    this.ROMFolder = null;

    this.SourceROM = null;
    this.SourceROMHeader = null;
    this.SourceROMSMCHeader = null;

    this.ByteArrayChecksum = null;
    this.ByteArrayInvChecksum = null;
    this.ByteArrayCalcChecksum = null;
    this.ByteArrayCalcInvChecksum = null;

    this.UIntROMHeaderOffset = 0;
    this.UIntSMCHeader = 0;
    this.UIntROMHeaderCopyOffset = 0;
    this.IntROMSize = 0;
    this.IntCalcFileSize = 0;
    this.CRC32Hash = null;
    this.MD5Hash = null;
    this.SHA1Hash = null;
    this.SHA256Hash = null;

    this.IsNewHeader = false;
    this.IsExROMHeaderCopied = false;
    this.IsBSROM = false;
    this.IsInterleaved = false;

    this.ByteROMType = 0;
    this.ByteROMSubtype = 0;
    this.ByteMapMode = 0;
    this.ByteROMSpeed = 0;
    this.ByteSRAMSize = 0;
    this.ByteExRAMSize = 0;
    this.ByteVersion = 0;
    this.ByteROMSize = 0;
    this.ByteArrayTitle = null;
    this.ByteTitleWhitespace = 0x20;
    this.ByteCountry = 0;
    this.IntCompany = 0;
    this.ByteArrayGameCode = null;

    this.StringROMType = '';
    this.StringMapMode = '';
    this.StringROMSpeed = '';
    this.StringRAMSize = '';
    this.StringVersion = '';
    this.StringROMSize = '';
    this.StringTitle = '';
    this.StringCountry = '';
    this.StringCompany = '';
    this.StringRegion = '';
    this.StringSMCHeader = '';
    this.StringGameCode = '';

    if (!fs.existsSync(romPath) || !fs.statSync(romPath).isFile()) {
      throw new ROMLoadError(`File not found: ${romPath}`);
    }

    this.ROMFullPath = romPath;
    this.ROMName = path.basename(romPath, path.extname(romPath));
    this.ROMFolder = path.dirname(romPath);

    const size = fs.statSync(romPath).size;

    if (size < MIN_ROM_SIZE || size > MAX_ROM_SIZE) {
      throw new ROMLoadError('ROMs cannot be smaller than 32 kByte (256 Kbit) or larger than 16 MByte (128 Mbit).');
    }

    this.SourceROM = new Uint8Array(fs.readFileSync(romPath));
    this.initialize(['all']);
  }

  initialize(refresh) {
    const r = (key) => refresh.includes('all') || refresh.includes(key);

    if (r('smcheader')) this.getSMCHeader();
    if (r('romheader')) this.getROMHeader();
    if (r('title')) this.getTitle();
    if (r('mapmode')) this.getMapMode();
    if (r('speed')) this.getROMSpeed();
    if (r('company')) this.getCompany();
    if (r('romsize')) this.getROMSize();
    if (r('romtype')) this.getROMType();
    if (r('newheader')) this.checkIsNewHeader();
    if (r('sramsize')) this.getSRAMSize();
    if (r('exramsize')) this.getExRAMSize();
    if (r('country')) this.getCountry();
    if (r('version')) this.getVersion();
    if (r('gamecode')) this.getGameCode();
    if (r('checksum')) {
      this.getChecksum();
      this.getInverseChecksum();
    }
    if (r('filesize')) this.IntCalcFileSize = F.calculateFileSize(this.SourceROM);
    if (r('checksum')) {
      this.ByteArrayCalcChecksum = F.calculateChecksum(this.SourceROM, this.UIntROMHeaderOffset, this.IsBSROM, this.IntROMSize, this.IntCalcFileSize, this.ByteROMType);
      this.ByteArrayCalcInvChecksum = F.calculateInverseChecksum(this.ByteArrayCalcChecksum);
      this.CRC32Hash = F.calculateCrc32Hash(this.SourceROM, this.SourceROMSMCHeader, this.UIntSMCHeader);
      this.MD5Hash = F.calculateHash('md5', this.SourceROM, this.SourceROMSMCHeader, this.UIntSMCHeader);
      this.SHA1Hash = F.calculateHash('sha1', this.SourceROM, this.SourceROMSMCHeader, this.UIntSMCHeader);
      this.SHA256Hash = F.calculateHash('sha256', this.SourceROM, this.SourceROMSMCHeader, this.UIntSMCHeader);
    }
  }

  getSMCHeader() {
    const existingSMCHeader = this.SourceROMSMCHeader ? this.SourceROMSMCHeader.length : 0;

    this.UIntSMCHeader = (this.SourceROM.length + existingSMCHeader) % 1024;

    if (this.UIntSMCHeader === 0) {
      this.StringSMCHeader = 'No';
    } else {
      this.StringSMCHeader = 'Malformed';

      if (this.SourceROMSMCHeader == null) {
        this.SourceROMSMCHeader = this.SourceROM.slice(0, this.UIntSMCHeader);
        this.SourceROM = this.SourceROM.slice(this.UIntSMCHeader);
      }
    }

    if (this.UIntSMCHeader === 512) {
      this.StringSMCHeader = 'Yes';
    }
  }

  getROMHeader() {
    this.UIntROMHeaderOffset = HeaderOffset.lorom;
    this.IsBSROM = false;

    const rom = this.SourceROM;
    const lo = F.calculateMapModeScore(rom, HeaderOffset.lorom, false);
    const bsLo = F.calculateMapModeScore(rom, HeaderOffset.lorom, true);
    const hi = F.calculateMapModeScore(rom, HeaderOffset.hirom, false);
    const bsHi = F.calculateMapModeScore(rom, HeaderOffset.hirom, true);
    const exLo = F.calculateMapModeScore(rom, HeaderOffset.exlorom, false);
    const exHi = F.calculateMapModeScore(rom, HeaderOffset.exhirom, false);

    if (lo >= hi && lo >= exLo && lo >= exHi) {
      this.UIntROMHeaderOffset = HeaderOffset.lorom;
      if (bsLo > lo) this.IsBSROM = true;
    } else if (hi >= exLo && hi >= exHi) {
      this.UIntROMHeaderOffset = HeaderOffset.hirom;
      if (bsHi > hi) this.IsBSROM = true;
    } else if (exLo >= exHi) {
      this.UIntROMHeaderOffset = HeaderOffset.exlorom;
    } else if (exHi > exLo) {
      this.UIntROMHeaderOffset = HeaderOffset.exhirom;
    }

    // Load header
    this.SourceROMHeader = new Uint8Array(80);
    this.SourceROMHeader.set(rom.subarray(this.UIntROMHeaderOffset, this.UIntROMHeaderOffset + 80));
  }

  getTitle() {
    let readTitle = true;
    let getWhitespace = false;
    const hdr = this.SourceROMHeader;
    const t = HeaderValue.title;

    if (this.ByteArrayTitle == null) {
      getWhitespace = true;

      if (this.IsBSROM) {
        this.ByteArrayTitle = new Uint8Array(16);
      } else {
        this.ByteArrayTitle = hdr.slice(t, t + 21);
        readTitle = false;

        if (this.ByteArrayTitle[20] === 0x00) {
          this.ByteArrayTitle = new Uint8Array(20);
          readTitle = true;
        }
      }
    }

    if (readTitle) {
      this.ByteArrayTitle = hdr.slice(t, t + this.ByteArrayTitle.length);
    }

    // Special cases where 0x00 is used as space instead of 0x20 like Waiwai Check 11-22
    if (getWhitespace) {
      this.ByteTitleWhitespace = this.ByteArrayTitle[this.ByteArrayTitle.length - 1] === 0x00 ? 0x00 : 0x20;
    }

    this.StringTitle = sjis.decode(this.ByteArrayTitle);
  }

  getMapMode() {
    this.IsInterleaved = false;
    this.IsExROMHeaderCopied = false;

    let mapMode = this.IsBSROM ? this.SourceROMHeader[HeaderValue.bs_mapmode] : this.SourceROMHeader[HeaderValue.mapmode];

    // SPC7110 games have an odd value in their header and don't have to be bitmasked
    if (mapMode !== MapMode.hirom_spc7110) {
      mapMode &= MapMode.bitmask;
    }

    this.ByteMapMode = mapMode;

    // ROM that contains oversized title which overwrites the map mode byte
    if (this.StringTitle === 'YUYU NO QUIZ DE GO!GO') {
      switch (this.UIntROMHeaderOffset) {
        case HeaderOffset.lorom: this.ByteMapMode = MapMode.lorom_1; break;
        case HeaderOffset.exlorom: this.ByteMapMode = MapMode.exlorom; break;
        case HeaderOffset.hirom: this.ByteMapMode = MapMode.hirom_1; break;
        case HeaderOffset.exhirom: this.ByteMapMode = MapMode.exhirom_1; break;
        default: break;
      }
    }

    const desc = getMapModeDescription(this.ByteMapMode);
    this.StringMapMode = desc || 'Unknown';

    // Check if the ROM is interleaved
    if (this.StringMapMode.includes(getMapModeDescription(0x21)) &&
      (this.UIntROMHeaderOffset === HeaderOffset.lorom || this.UIntROMHeaderOffset === HeaderOffset.exlorom)) {
      this.IsInterleaved = true;
    }

    // In case we have ExROM sized source ROM file, check if header has been copied (title compare)
    if (this.SourceROM.length >= 0x40FFFF) {
      let headerCopyOffset = this.UIntROMHeaderOffset;

      switch (this.UIntROMHeaderOffset) {
        case HeaderOffset.lorom: headerCopyOffset += this.IsInterleaved ? 0x200000 : 0x400000; break;
        case HeaderOffset.hirom: headerCopyOffset += 0x400000; break;
        case HeaderOffset.exlorom: headerCopyOffset -= this.IsInterleaved ? 0x200000 : 0x400000; break;
        case HeaderOffset.exhirom: headerCopyOffset -= 0x400000; break;
        default: break;
      }

      const start = headerCopyOffset + HeaderValue.title;
      const copyTitle = this.SourceROM.subarray(start, start + this.ByteArrayTitle.length);

      if (F.bytesEqual(this.ByteArrayTitle, copyTitle)) {
        this.IsExROMHeaderCopied = true;
        this.UIntROMHeaderCopyOffset = headerCopyOffset;
      }
    }
  }

  getROMType() {
    const hdr = this.SourceROMHeader;

    if (this.IsBSROM) {
      this.ByteROMType = hdr[HeaderValue.bs_type];
      this.ByteROMSubtype = 0;
    } else {
      this.ByteROMType = hdr[HeaderValue.type];
      this.ByteROMSubtype = hdr[HeaderValue.subtype];
    }

    const title = this.StringTitle;
    let t;

    switch (this.ByteROMType) {
      case 0x00: t = this.IsBSROM ? 'BS-X+FLASH+SoundLink' : 'ROM Only'; break;
      case 0x01: t = 'ROM+RAM'; break;
      case 0x02: t = 'ROM+RAM+Battery'; break;
      case 0x03: t = (this.ByteROMSpeed === 0x30 && !FALSE_DSP1_GAMES.includes(title)) ? 'ROM+DSP4' : 'ROM+DSP1'; break;
      case 0x04: t = 'ROM+DSP1+RAM'; break;
      case 0x05:
        if (this.ByteROMSpeed === Speed.slow) t = 'ROM+DSP2+RAM+Battery';
        else if (this.ByteROMSpeed === Speed.fast && this.IntCompany === 0x018E) t = 'ROM+DSP3+RAM+Battery';
        else t = 'ROM+DSP1+RAM+Battery';
        break;
      case 0x10: if (this.IsBSROM) t = 'BS-X+FLASH'; break;
      case 0x13: t = 'ROM+MarioChip1+RAM'; break;
      case 0x14: t = this.ByteROMSize > 0x0A ? 'ROM+GSU2+RAM' : 'ROM+GSU1+RAM'; break;
      case 0x15: t = (this.ByteROMSize <= 0x0A && !FALSE_GSU2_GAMES.includes(title)) ? 'ROM+GSU1+RAM+Battery' : 'ROM+GSU2+RAM+Battery'; break;
      case 0x17: t = 'ROM+GSU3+RAM'; break;
      case 0x18: t = 'ROM+GSU3+RAM+Battery'; break;
      case 0x1A: t = 'ROM+GSU1+RAM+Battery'; break;
      case 0x20: if (this.IsBSROM) t = 'BS-X+PSRAM+SoundLink'; break;
      case 0x25: t = 'ROM+OBC1+RAM+Battery'; break;
      case 0x30: if (this.IsBSROM) t = 'BS-X+PSRAM'; break;
      case 0x32: t = 'ROM+SA1+RAM+Battery'; break;
      case 0x34: t = 'ROM+SA1+RAM'; break;
      case 0x35: t = 'ROM+SA1+RAM+Battery'; break;
      case 0x36: t = 'ROM+SA1'; break;
      case 0x43: t = 'ROM+S-DD1'; break;
      case 0x45: t = 'ROM+S-DD1+RAM+Battery'; break;
      case 0x55: t = 'ROM+S-RTC+RAM+Battery'; break;
      case 0x63: t = 'ROM+RP2040+FLASH'; break;
      case 0xA0: if (this.IsBSROM) t = 'BS-X+SoundNovel'; break;
      case 0xE3: t = 'ROM+SGB'; break;
      case 0xE5: t = 'ROM+BS-X'; break;
      case 0xF3: t = 'ROM+CX-4'; break;
      case 0xF5:
        if (this.StringMapMode.includes(getMapModeDescription(0x21))) t = 'ROM+SPC-7110+RAM+Battery';
        else if (this.StringMapMode.includes(getMapModeDescription(0x20))) t = 'ROM+ST-018+RAM+Battery';
        break;
      case 0xF6: t = this.ByteROMSize === 0x0A ? 'ROM+ST-010' : 'ROM+ST-011'; break;
      case 0xF9: t = 'ROM+SPC-7110+RTC+RAM+Battery'; break;
      default: t = 'Unknown'; break;
    }

    // Cases without assignment keep the previous value (like in the C# version)
    if (t !== undefined) this.StringROMType = t;

    if (this.ByteROMSubtype === 0x52) {
      this.StringROMType += '+Rumble';
    }
  }

  getROMSpeed() {
    this.ByteROMSpeed = this.ByteMapMode & 0xF0;
    this.StringROMSpeed = getSpeedDescription(this.ByteROMSpeed) || 'Unknown';
  }

  getROMSize() {
    const hdr = this.SourceROMHeader;

    if (this.IsBSROM) {
      let byteSize = (hdr[HeaderValue.bs_size] | (hdr[HeaderValue.bs_size + 1] << 8) |
        (hdr[HeaderValue.bs_size + 2] << 16) | (hdr[HeaderValue.bs_size + 3] << 24)) >>> 0;

      if (byteSize > 0) {
        this.IntROMSize = 1;
        while (byteSize > 1) {
          byteSize >>>= 1;
          this.IntROMSize++;
        }
        this.ByteROMSize = this.IntROMSize & 0xFF;
        this.StringROMSize = `${this.IntROMSize} Mbit`;
      } else {
        this.IntROMSize = 0;
        this.ByteROMSize = 0;
        this.StringROMSize = 'Unknown';
      }
    } else {
      this.ByteROMSize = hdr[HeaderValue.size];

      // 0x05 = 32 kByte (256 Kbit, homebrew / test ROMs) ... 0x0E = 16 MByte; size = 2^n kByte
      if (this.ByteROMSize >= 0x05 && this.ByteROMSize <= 0x0E) {
        this.IntROMSize = Math.pow(2, this.ByteROMSize - 7);
        this.StringROMSize = F.formatMbit(this.IntROMSize);
      } else {
        this.IntROMSize = 0;
        this.ByteROMSize = 0;
        this.StringROMSize = 'Unknown';
      }
    }
  }

  checkIsNewHeader() {
    this.IsNewHeader = this.SourceROMHeader[HeaderValue.company] === 0x33;
  }

  getSRAMSize() {
    this.ByteSRAMSize = this.IsBSROM ? 0x00 : this.SourceROMHeader[HeaderValue.sram];
  }

  getExRAMSize() {
    let exram = 0x00;

    if (!this.IsBSROM) {
      if (this.IsNewHeader) {
        exram = this.SourceROMHeader[HeaderValue.exram];
      } else if (this.StringTitle.includes('STAR FOX') || this.StringTitle.includes('STAR WING')) {
        // Star Fox/Star Wing RAM fix
        exram = 0x06;
      }
    }

    this.ByteExRAMSize = exram;
    this.StringRAMSize = 'No';

    if (this.ByteSRAMSize > 0x00) {
      this.StringRAMSize = `Yes (${Math.pow(2, this.ByteSRAMSize)} kByte)`;
    } else if (this.ByteExRAMSize > 0x00) {
      this.StringRAMSize = `Yes (${Math.pow(2, this.ByteExRAMSize)} kByte)`;
    }
  }

  getCountry() {
    this.ByteCountry = this.IsBSROM ? 0x00 : this.SourceROMHeader[HeaderValue.country];
    const entry = CountryRegion[this.ByteCountry];

    if (entry) {
      [this.StringCountry, this.StringRegion] = entry;
    } else {
      this.StringCountry = 'Unknown';
      this.StringRegion = '?';
    }
  }

  getCompany() {
    const value = this.SourceROMHeader[HeaderValue.company];
    const companyCode = value !== CC.NEW_HEADER_MARKER
      ? CC.decodeOld(value)
      : CC.decodeNew(this.SourceROMHeader[0x00], this.SourceROMHeader[0x01]);

    this.IntCompany = companyCode;

    const key = CC.codeKey(companyCode);
    this.StringCompany = Object.prototype.hasOwnProperty.call(Company, key) ? Company[key] : 'Unknown';
  }

  getChecksum() {
    // big endian
    const p = HeaderValue.checksum;
    this.ByteArrayChecksum = Uint8Array.of(this.SourceROMHeader[p + 1], this.SourceROMHeader[p]);
  }

  getInverseChecksum() {
    // big endian
    const p = HeaderValue.inverse_checksum;
    this.ByteArrayInvChecksum = Uint8Array.of(this.SourceROMHeader[p + 1], this.SourceROMHeader[p]);
  }

  getVersion() {
    this.ByteVersion = this.SourceROMHeader[HeaderValue.version];
    this.StringVersion = `1.${this.ByteVersion}`;
  }

  getGameCode() {
    if (this.IsNewHeader && !this.IsBSROM) {
      const p = HeaderValue.gamecode;
      this.ByteArrayGameCode = this.SourceROMHeader.slice(p, p + 4);
      this.StringGameCode = sjis.decode(this.ByteArrayGameCode);

      switch (this.StringGameCode) {
        case '042J': if (this.ByteROMType === 0x00) this.StringROMType = 'ROM+SGB2'; break;
        case 'XBND': if (this.ByteROMType === 0x02 && !this.StringROMType.endsWith('+XBandModem')) this.StringROMType += '+XBandModem'; break;
        case 'MENU': if (this.ByteROMType === 0x02 && !this.StringROMType.endsWith('+Nintendo Power')) this.StringROMType += '+Nintendo Power'; break;
        default: break;
      }
    } else {
      this.StringGameCode = 'N/A';
    }
  }

  /* -------------------------------------------------------------- */
  /* Setters                                                          */
  /* -------------------------------------------------------------- */

  writeHeaderBytes(relOffset, bytes) {
    this.SourceROM.set(bytes, this.UIntROMHeaderOffset + relOffset);
    if (this.IsExROMHeaderCopied) {
      this.SourceROM.set(bytes, this.UIntROMHeaderCopyOffset + relOffset);
    }
  }

  setTitle(newTitle, maxLength) {
    // Only whole characters: a double byte character that would be cut in half is left out,
    // the remaining byte(s) are filled with the title's whitespace (usually 0x20)
    const encoded = sjis.encodeLimited(newTitle.trim(), maxLength);
    const title = new Uint8Array(maxLength).fill(this.ByteTitleWhitespace);
    title.set(encoded, 0);

    this.writeHeaderBytes(HeaderValue.title, title);
    this.initialize(['romheader', 'title', 'checksum']);
  }

  setVersion(newVersion) {
    this.writeHeaderBytes(HeaderValue.version, Uint8Array.of(newVersion & 0xFF));
    this.initialize(['romheader', 'version', 'checksum']);
  }

  setCountryRegion(newCountryRegion) {
    this.writeHeaderBytes(HeaderValue.country, Uint8Array.of(newCountryRegion & 0xFF));
    this.initialize(['romheader', 'country', 'checksum']);
  }

  setGameCode(newGameCode) {
    // Game codes consist of ASCII characters A-Z and 0-9 only
    const clean = GameCode.sanitize(newGameCode);
    const encoded = Uint8Array.from(clean, (c) => c.charCodeAt(0));
    const code = Uint8Array.of(0x20, 0x20, 0x20, 0x20);
    code.set(encoded.subarray(0, 4), 0);

    this.writeHeaderBytes(HeaderValue.gamecode, code);
    this.initialize(['romheader', 'gamecode', 'checksum']);
  }

  /* -------------------------------------------------------------- */
  /* Company                                                          */
  /* -------------------------------------------------------------- */

  /** True if the header uses the extended header with a 2 char maker code ($FFDA == 0x33) */
  get hasMakerCode() {
    return this.SourceROMHeader[HeaderValue.company] === CC.NEW_HEADER_MARKER;
  }

  /**
   * Companies that can be stored in this ROM's header.
   * Old header: only codes representable as one byte (both base 36 digits 0-F, not 0x33).
   * Extended header: all codes (2 char maker code at $FFB0).
   * @returns {Array<{code: number, name: string, notation: string}>}
   */
  getCompanyOptions() {
    const newHeader = this.hasMakerCode;
    const options = [];

    for (const [key, name] of Object.entries(Company)) {
      const code = parseInt(key, 16);
      const possible = newHeader ? CC.encodeNew(code) !== null : CC.encodeOld(code) !== null;
      if (possible) options.push({ code, name, notation: CC.headerNotation(code, newHeader) });
    }

    // Keep the current (unknown) code selectable
    if (!options.some((o) => o.code === this.IntCompany)) {
      options.push({ code: this.IntCompany, name: this.StringCompany, notation: CC.headerNotation(this.IntCompany, newHeader) });
    }

    return options.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.code - b.code);
  }

  /**
   * Sets the company (code = key of lists/company.js as number).
   * The header type is not changed: an old header gets one byte at $FFDA,
   * an extended header gets the 2 char maker code at $FFB0.
   * @returns {boolean} false if the code cannot be stored in this header type
   */
  setCompany(code) {
    const value = Number(code);

    if (this.hasMakerCode) {
      const bytes = CC.encodeNew(value);
      if (!bytes) return false;
      this.writeHeaderBytes(0x00, bytes);
    } else {
      const byte = CC.encodeOld(value);
      if (byte === null) return false;
      this.writeHeaderBytes(HeaderValue.company, Uint8Array.of(byte));
    }

    // ROM type depends on the company (f.e. DSP3), game code depends on ROM type
    this.initialize(['romheader', 'company', 'romtype', 'gamecode', 'checksum']);
    return true;
  }

  /* -------------------------------------------------------------- */
  /* SRAM size                                                        */
  /* -------------------------------------------------------------- */

  /** True for Super FX (GSU / MarioChip) cartridges */
  get isSuperFX() {
    return !this.IsBSROM && (this.ByteROMType & 0xF0) === 0x10 && (this.ByteROMType & 0x0F) >= 0x03;
  }

  /**
   * Describes whether and where the (S)RAM size can be changed.
   * - Normal ROMs: RAM size byte of the standard header ($FFD8)
   * - Super FX with extended header: expansion RAM size ($FFBD)
   * - Super FX without extended header (f.e. Star Fox / Star Wing) and BS-X: not possible,
   *   because their header has no field describing the cartridge RAM
   * @returns {{editable: boolean, target: 'sram'|'exram'|null, value: number, reason: string}}
   */
  getSRAMSizeInfo() {
    if (this.IsBSROM) {
      return { editable: false, target: null, value: 0, reason: 'BS-X ROMs have no SRAM size field in their header.' };
    }

    if (this.isSuperFX) {
      if (!this.IsNewHeader) {
        return {
          editable: false,
          target: null,
          value: this.ByteExRAMSize,
          reason: 'Super FX game without extended header (f.e. Star Fox / Star Wing): the cartridge RAM is not described in the header.',
        };
      }
      return { editable: true, target: 'exram', value: this.SourceROMHeader[HeaderValue.exram], reason: 'Super FX: expansion RAM size ($FFBD)' };
    }

    return { editable: true, target: 'sram', value: this.ByteSRAMSize, reason: 'RAM size ($FFD8)' };
  }

  /**
   * Sets the (S)RAM size: 0 = none, n = 2^n kByte (1 = 2 kByte ... 7 = 128 kByte)
   * @returns {boolean} false if not possible for this ROM
   */
  setSRAMSize(sizeValue) {
    const info = this.getSRAMSizeInfo();
    const value = Number(sizeValue);

    if (!info.editable || !Number.isInteger(value) || value < 0 || value > 0x0F) {
      return false;
    }

    const offset = info.target === 'exram' ? HeaderValue.exram : HeaderValue.sram;
    this.writeHeaderBytes(offset, Uint8Array.of(value));
    this.initialize(['romheader', 'sramsize', 'exramsize', 'checksum']);
    return true;
  }

  /* -------------------------------------------------------------- */
  /* Convenience                                                      */
  /* -------------------------------------------------------------- */

  /** ROM incl. SMC header (if any), as written to disk */
  getMergedROM() {
    return F.mergeHeader(this.SourceROM, this.SourceROMSMCHeader, this.UIntSMCHeader);
  }

  /** Byte array that is written when saving (header included, if one exists) */
  getSaveData() {
    if (this.SourceROMSMCHeader) {
      const merged = new Uint8Array(this.SourceROMSMCHeader.length + this.SourceROM.length);
      merged.set(this.SourceROMSMCHeader, 0);
      merged.set(this.SourceROM, this.SourceROMSMCHeader.length);
      return merged;
    }
    return this.SourceROM;
  }

  get checksumHex() { return hex(this.ByteArrayChecksum); }
  get invChecksumHex() { return hex(this.ByteArrayInvChecksum); }
  get calcChecksumHex() { return hex(this.ByteArrayCalcChecksum); }
  get calcInvChecksumHex() { return hex(this.ByteArrayCalcInvChecksum); }
}

module.exports = { SNESROM, ROMLoadError, MIN_ROM_SIZE, MAX_ROM_SIZE };
