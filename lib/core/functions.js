'use strict';

// Ported from Functions/*.cs and Helper/RegExReplace.cs

const crypto = require('crypto');
const { HeaderOffset, HeaderValue, MapMode } = require('./enums');
const { crc32Hex } = require('./helper/crc32');

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/** Merges SMC header and ROM (like the C# code does before hashing / patching / saving) */
function mergeHeader(sourceROM, sourceROMSMCHeader, uIntSMCHeader) {
  if (sourceROMSMCHeader && uIntSMCHeader > 0) {
    const merged = new Uint8Array(sourceROMSMCHeader.length + sourceROM.length);
    merged.set(sourceROMSMCHeader, 0);
    merged.set(sourceROM, sourceROMSMCHeader.length);
    return merged;
  }
  return sourceROM;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, '0'));

function bytesToHex(bytes) {
  // Build in chunks to avoid huge intermediate arrays
  const chunk = 65536;
  const parts = [];
  for (let i = 0; i < bytes.length; i += chunk) {
    const end = Math.min(i + chunk, bytes.length);
    const sub = new Array(end - i);
    for (let j = i; j < end; j++) sub[j - i] = HEX[bytes[j]];
    parts.push(sub.join(''));
  }
  return parts.join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Calculations                                                         */
/* ------------------------------------------------------------------ */

/**
 * File size in Mbit. From 1 Mbit on whole Mbit (as before), below 1 Mbit the exact
 * fraction (f.e. 0.25 for 32 kByte homebrew / test ROMs).
 */
function calculateFileSize(sourceROM) {
  const mbit = (sourceROM.length * 8) / 1048576;
  return mbit >= 1 ? Math.trunc(mbit) : mbit;
}

/** Formats a size in Mbit: "8 Mbit", below 1 Mbit in Kbit ("256 Kbit") */
function formatMbit(mbit) {
  return mbit >= 1 ? `${mbit} Mbit` : `${Math.round(mbit * 1024)} Kbit`;
}

/** Formats a size in Mbit as bytes: "1 MByte" / "1,5 MByte", below 1 MByte in kByte ("32 kByte") */
function formatMByte(mbit) {
  return mbit >= 8 ? `${String(mbit / 8).replace('.', ',')} MByte` : `${Math.round(mbit * 128)} kByte`;
}

/**
 * Returns checksum as big endian [hi, lo]
 */
function calculateChecksum(sourceROM, uIntROMHeaderOffset, isBSROM, intROMSize, intCalcFileSize, byteROMType) {
  // Lazy require to avoid circular dependency
  const { mirror } = require('./converter');

  const offsetChksm = uIntROMHeaderOffset + HeaderValue.inverse_checksum;
  let multiplier = 1;

  // Make a copy with clean checksum of the ROM for independent calculation
  let rom = new Uint8Array(sourceROM);
  rom.set([0xFF, 0xFF, 0x00, 0x00], offsetChksm);

  // For BS-X ROMs fill header with 0x00
  if (isBSROM) {
    rom.fill(0x00, uIntROMHeaderOffset, uIntROMHeaderOffset + 48);
  }

  // Mirror ROM if neccessary | not working for Momotarou Dentetsu Happy and Tengai Makyou Zero
  if ((intROMSize > intCalcFileSize) && byteROMType !== 0xF5 && byteROMType !== 0xF9) {
    rom = mirror(rom, intROMSize, intCalcFileSize);
  } else if (intROMSize === 32 && byteROMType === 0xF5) {
    // Momotarou Dentetsu Happy fix
    multiplier = 2;
  }

  let checksum = 0;
  for (let i = 0; i < rom.length; i++) {
    checksum = (checksum + rom[i]) & 0xFFFF;
  }

  checksum = (checksum * multiplier) & 0xFFFF;

  return Uint8Array.of((checksum >> 8) & 0xFF, checksum & 0xFF);
}

/** Inverse of a big endian checksum, returned big endian as well */
function calculateInverseChecksum(byteArrayCalcChecksum) {
  return Uint8Array.of(byteArrayCalcChecksum[0] ^ 0xFF, byteArrayCalcChecksum[1] ^ 0xFF);
}

function calculateCrc32Hash(sourceROM, sourceROMSMCHeader, uIntSMCHeader) {
  return crc32Hex(mergeHeader(sourceROM, sourceROMSMCHeader, uIntSMCHeader));
}

function calculateHash(algorithm, sourceROM, sourceROMSMCHeader, uIntSMCHeader) {
  return crypto.createHash(algorithm).update(mergeHeader(sourceROM, sourceROMSMCHeader, uIntSMCHeader)).digest('hex');
}

const readU16LE = (rom, pos) => rom[pos] | (rom[pos + 1] << 8);

function calculateMapModeScore(sourceROM, offset, isBSROM) {
  // Check if ROM has normal or extended size
  if (sourceROM.length < offset + 0x50) {
    return -100;
  }

  let score = 0;

  const resetVector = readU16LE(sourceROM, offset + 0x4C);
  const checksum = readU16LE(sourceROM, offset + 0x2E);
  const checksumInverse = readU16LE(sourceROM, offset + 0x2C);
  let mapMode = isBSROM ? sourceROM[offset + 0x28] : sourceROM[offset + 0x25];

  // Bitmask this byte, because non relevant bits are not clearly defined
  mapMode &= 0x37;

  const romSize = sourceROM[offset + 0x27];
  const destinationCode = sourceROM[offset + 0x29];
  const fixedValue33 = sourceROM[offset + 0x2A];
  const opCode = sourceROM[resetVector];

  // Check if reset vector is pointing to an address greater than or equal to 0x8000
  if (resetVector < 0x8000) {
    return -100;
  }

  // Most likely opcodes: sei, clc, sec, stz $nnnn, jmp $nnnn, jml $nnnnnn
  if ([0x78, 0x18, 0x38, 0x9C, 0x4C, 0x5C].includes(opCode)) {
    score += 8;
  }

  // Plausible opcodes: rep, sep, lda, ldx, ldy, lda long, lda #, ldx #, ldy #, jsr, jsl
  if ([0xC2, 0xE2, 0xAD, 0xAE, 0xAC, 0xAF, 0xA9, 0xA2, 0xA0, 0x20, 0x22].includes(opCode)) {
    score += 4;
  }

  // Implausible opcodes: rti, rts, rtl, cmp, cpx, cpy
  if ([0x40, 0x60, 0x6B, 0xCD, 0xEC, 0xCC].includes(opCode)) {
    score -= 4;
  }

  // Least likely opcodes: brk, cop, stp, wdm, sbc long,x
  if ([0x00, 0x02, 0xDB, 0x42, 0xFF].includes(opCode)) {
    score -= 8;
  }

  // Check if checksums add up to 0xFFFF
  if (checksum + checksumInverse === 0xFFFF) {
    score += 4;
  }

  // Check if internal ROM type is valid
  if (offset === HeaderOffset.lorom && (mapMode === MapMode.lorom_1 || mapMode === MapMode.lorom_2)) {
    score += 2;
  }
  if (offset === HeaderOffset.hirom && (mapMode === MapMode.hirom_1 || mapMode === MapMode.hirom_2 || mapMode === MapMode.hirom_spc7110)) {
    score += 2;
  }
  // ExLoROM - f.e. Star Ocean
  if (offset === HeaderOffset.exlorom && mapMode === MapMode.exlorom) {
    score += 4;
  }
  // ExHiROM - f.e. Tales Of Phantasia
  if (offset === HeaderOffset.exhirom && (mapMode === MapMode.exhirom_1 || mapMode === MapMode.exhirom_2)) {
    score += 4;
  }

  // Check if internal ROM size is vaild
  if (romSize >= 0x07 && romSize <= 0x0D) {
    score += 2;
  }

  // Check if destination code size is vaild
  if (destinationCode <= 0x14) {
    score += 2;
  }

  // Check for some fixed ROM values
  if (fixedValue33 === 0x33) {
    score += 4;
  }

  let allZero = true;
  for (let i = 0; i < 7; i++) {
    if (sourceROM[offset + 0x06 + i] !== 0x00) { allZero = false; break; }
  }
  if (allZero) {
    score += 2;
  }

  // If game is tested for being BS-X and title starts with 'BS' like most of them do
  if (isBSROM && sourceROM[offset + 0x10] === 0x42 && sourceROM[offset + 0x11] === 0x53) {
    score += 2;
  }

  return score;
}

/* ------------------------------------------------------------------ */
/* Header functions                                                     */
/* ------------------------------------------------------------------ */

function addHeader(rom) {
  rom.SourceROMSMCHeader = new Uint8Array(512);
  rom.initialize(['smcheader', 'filesize', 'checksum']);
}

function removeHeader(rom) {
  rom.SourceROMSMCHeader = null;
  rom.initialize(['smcheader', 'filesize', 'checksum']);
}

function fixChecksum(rom) {
  const chk = rom.ByteArrayCalcChecksum;
  const inv = rom.ByteArrayCalcInvChecksum;

  // Little endian sequence: inverse checksum, checksum
  const seq = Uint8Array.of(inv[1], inv[0], chk[1], chk[0]);

  rom.SourceROM.set(seq, rom.UIntROMHeaderOffset + HeaderValue.inverse_checksum);

  if (rom.IsExROMHeaderCopied) {
    const copyPos = rom.UIntROMHeaderCopyOffset + HeaderValue.inverse_checksum;
    const current = rom.SourceROM.subarray(copyPos, copyPos + 4);

    // Some games like Tales of Phantasia might have a default checksum in their copied header
    if (!bytesEqual(current, Uint8Array.of(0xFF, 0xFF, 0x00, 0x00))) {
      rom.SourceROM.set(seq, copyPos);
    }
  }

  rom.initialize(['romheader', 'checksum']);
}

function needsInternalROMSizeFix(rom) {
  return rom.IntROMSize < rom.IntCalcFileSize || rom.IntCalcFileSize <= rom.IntROMSize / 2;
}

function fixInternalROMSize(rom) {
  if (!needsInternalROMSizeFix(rom)) return;

  rom.IntROMSize = 1;

  if (!rom.IsBSROM) {
    // Smallest size value: 0x05 = 32 kByte (256 Kbit)
    let sizeValue = 0x05;
    rom.IntROMSize = 0.25;

    while (rom.IntROMSize < rom.IntCalcFileSize) {
      rom.IntROMSize *= 2;
      sizeValue++;
    }

    rom.SourceROM[rom.UIntROMHeaderOffset + HeaderValue.size] = sizeValue & 0xFF;

    if (rom.IsExROMHeaderCopied) {
      rom.SourceROM[rom.UIntROMHeaderCopyOffset + HeaderValue.size] = sizeValue & 0xFF;
    }
  } else {
    rom.IntROMSize = rom.IntCalcFileSize;

    let size = 1;
    let sizeCtr = rom.IntROMSize;

    while (sizeCtr > 1) {
      size = ((size << 1) | 1) >>> 0;
      sizeCtr--;
    }

    const pos = rom.UIntROMHeaderOffset + 0x20;
    rom.SourceROM[pos] = size & 0xFF;
    rom.SourceROM[pos + 1] = (size >>> 8) & 0xFF;
    rom.SourceROM[pos + 2] = (size >>> 16) & 0xFF;
    rom.SourceROM[pos + 3] = (size >>> 24) & 0xFF;
  }

  rom.initialize(['romheader', 'romsize', 'filesize', 'checksum']);
}

/* ------------------------------------------------------------------ */
/* Copy protection removal                                              */
/* ------------------------------------------------------------------ */

/**
 * Port of SNESROMHelper.FindAndReplaceByRegEx
 * @param {Array<[string,string]>} lockingCodes list of [pattern, replacement]
 */
function findAndReplaceByRegEx(rom, lockingCodes, unlock) {
  let bytes = rom.SourceROM;
  let hex = null;
  let dirty = true;
  let matchCtr = 0;

  for (const [pattern, replacement] of lockingCodes) {
    if (dirty) {
      hex = bytesToHex(bytes);
      dirty = false;
    }

    const regex = new RegExp(pattern, 'g');
    const single = new RegExp(pattern);
    let changedInThisPattern = false;

    for (const match of hex.matchAll(regex)) {
      if (match.index % 2 !== 0) continue;

      if (!unlock) {
        return true;
      }

      const newHex = match[0].replace(single, replacement).replace(/ /g, '');
      const newBytes = hexToBytes(newHex);

      if (!changedInThisPattern) {
        // Copy on first write so the original array is not touched until we are done
        if (bytes === rom.SourceROM) bytes = new Uint8Array(rom.SourceROM);
        changedInThisPattern = true;
      }

      bytes.set(newBytes.subarray(0, Math.min(newBytes.length, bytes.length - match.index / 2)), match.index / 2);
      matchCtr++;
    }

    if (changedInThisPattern) dirty = true;
  }

  if (matchCtr > 0) {
    rom.SourceROM = bytes;
    rom.initialize(['checksum']);
    return true;
  }

  return false;
}

function removeRegionChecks(rom, unlock = true) {
  const codes = [];

  if (rom.StringRegion === 'PAL') {
    codes.push(
      ['(AD3F21291000)(D0)', '$1 80'],
      ['(AD3F21)(891000D0)', 'A9 10 00 $2'],
      ['(AD3F212910CFBDFF)(\\w{2})(F0)', '$1 $2 80'],
      ['(AD3F218910)(D0)', '$1 80'],
      ['(AD3F218910)(F0)', '$1 EA EA'],
      ['(AF3F21002910)(D0)', '$1 80'],
      ['(AF3F2100291000)(D0)', '$1 EA EA'],
      ['(AF3F210029)(\\w{2})(C9)(\\w{2})(F0)', '$1 $2 $3 $4 80'],
      ['(A21801BD2720891000)(F001)', '$1 EA EA'],
      ['(AF3F2100)(89)(1000)', '$1 A9 $3'],          // Asterix & Obelix
      ['(AF3F2100C220)(29)(1000)', '$1 A9 $3'],      // 90 Minutes - European Prime Goal
      ['(AF3F2100)(29)(10C2)', '$1 A9 $3'],          // California Games 2
      ['(AD3F21)(29)(108562C2)', '$1 A9 $3'],        // Dirt Racer
    );
  } else {
    codes.push(
      ['(3F21)(29|89)(10)(F0)', '$1 $2 $3 80'],
      ['(AD3F21)(29|89)(10)(D0)', '$1 $2 $3 EA EA'],
      ['(3F21)(29|89)(1000)(F0)', '$1  $2 $3 80'],
      ['(3F21)(29|89)(1000)(D0)', '$1 $2 $3 EA EA'],
      ['(3F218910C2)(\\w{2})(F0)', '$1 $2 80'],
      ['(3F218910C2)(\\w{2})(D0)', '$1 $2 EA EA'],
      ['(3F21)(29|89)(10C910)(F0)', '$1  $2 $3 80'],
      ['(AD3F212910C900)(F0)', '$1 EA EA'],
      ['(AD3F212910C900)(D0)', '$1 80'],
      ['(AD3F212910C910)(D0)', '$1 EA EA'],
      ['(3F212910CF)(\\w{4})(80)(F0)', '$1 $2 $3 80'],
      ['(AD3F218D)(\\w{4})(29)(10)(8D)', '$1 $2 $3 00 $5'],
      ['(3F2100)(29|89)(10)(F0)', '$1 $2 $3 80'],
      ['(AF3F2100)(29|89)(10)(D0)', '$1 $2 $3 EA EA'],
      ['(AF3F2100)(29|89)(1000)(F0)', '$1 $2 $3 80'],
      ['(AF3F210029)(\\w{2})(C9)(\\w{2})(F0)', '$1 $2 $3 $4 80'],
      ['(AF3F210029)(10)(802D001B)', '$1 00 $3'],
      ['(3F21008910C2)(\\w{2})(F0)', '$1 $2 80'],
      ['(AF3F2100)(\\w{4})(291000)(D0)', '$1 $2 $3 EA EA'],
      ['(3F21C2)(\\w{2})(291000)(F0)', '$1 $2 $3 80'],
      ['(3F21C2)(\\w{2})(291000)(D0)', '$1 $2 $3 EA EA'],
      ['(AF3F21)(EA891000D0)', 'A9 00 00 $2'],
      ['(A21801BD2720891000)(D001)', '$1 EA EA'],
      ['(291000A20000C91000)(D0)', '$1 80'],
      ['(AD3F2129)(0F)', '$1 FF'], // Dezaemon - Kaite Tsukutte Asoberu
      ['(ADFF1FD006)(22645FC08004)(22008A0F)(C230AB2B7AFA6840)', 'EA EA EA EA EA $2 EA EA EA EA $4'], // Cooly Skunk
      // Earthbound
      ['(AD39B5)(D01A)(22)', '$1 EA EA $3'],
      ['(A1C0CA10F838)(EFF2FDC3F0)', '$1 EA A9 00 00 80'],
      ['(A1C0CA10F8)(EF38F2FDC3F0)', '$1 38 EA A9 00 00 80'],
      ['(A1C0CA10F838)(EFEFFFC1)', '$1 EA A9 00 00'],
    );
  }

  return findAndReplaceByRegEx(rom, codes, unlock);
}

function removeSRAMChecks(rom, unlock = true) {
  const codes = [];
  const title = rom.StringTitle;

  if (rom.ByteSRAMSize > 0x00) {
    if (rom.StringMapMode.includes('LoROM')) {
      const excludedTitles = ['OHCHAN NO LOGIC'];

      if (rom.ByteSRAMSize === 0x03 || excludedTitles.includes(title.trim())) {
        codes.push(['(8F|9F)(\\w{4})(70)(CF|DF)(\\w{4})(70)(D0)', '$1 $2 $3 $4 $5 $6 EA EA']);
        codes.push(['(8F|9F)(\\w{4})(70)(CF|DF)(\\w{4})(70)(F0)', '$1 $2 $3 $4 $5 $6 80']);
      } else {
        codes.push(['(8F|9F)(\\w{4})(70)(CF|DF)(\\w{4})(70)(D0)', '$1 $2 $3 $4 $5 $6 80']);
        codes.push(['(8F|9F)(\\w{4})(70)(CF|DF)(\\w{4})(70)(F0)', '$1 $2 $3 $4 $5 $6 EA EA']);
      }

      codes.push(
        ['(A90000A2FE1FDF000070)(D0)', '$1 EA EA'],                                          // Super Metroid
        ['(8F)(\\w{4})(77E2)(\\w{2})(AF)(\\w{4})(77C9)(\\w{2})(F0)', '$1 $2 $3 $4 $5 $6 $7 $8 80'], // Uniracers / Unirally
        ['(CA10F838EF1A8081)(8D)', '$1 9C'],                                                 // Kirby's Dream Course
        ['(81CA10F8CF398087)(F0)', '$1 80'],                                                 // Kirby's Dream Course
      );

      return findAndReplaceByRegEx(rom, codes, unlock);
    } else if (rom.StringMapMode.includes('HiROM')) {
      if (title.includes('DONKEY KONG COUNTRY') || title.includes('SUPER DONKEY KONG')) {
        codes.push(['(8F|9F)(57|59)(60|68)(30|31|32|33)(CF|DF)(57|59)(60)(30|31|32|33)(D0)', '$1 $2 $3 $4 $5 $6 $7 $8 EA EA']); // Donkey Kong Country
      }

      if (title.includes('DONKEY KONG COUNTRY')) {
        codes.push(['(8F|9F)(\\w{4})(30|31|32|33)(CF|DF)(\\w{4})(30|31|32|33)(D0)', '$1 $2 $3 $4 $5 $6 EA EA']);
      } else {
        codes.push(['(8F|9F)(\\w{4})(30|31|32|33)(CF|DF)(\\w{4})(30|31|32|33)(D0)', '$1 $2 $3 $4 $5 $6 80']);
      }

      if (!title.includes('EARTH BOUND')) {
        codes.push(['(8F|9F)(\\w{4})(30|31|32|33)(CF|DF)(\\w{4})(30|31|32|33)(F0)', '$1 $2 $3 $4 $5 $6 EA EA']);
      }

      codes.push(
        ['(8F|9F)(\\w{4})(30|31|32|33)(AF)(\\w{4})(30|31|32|33)(C9)(\\w{4})(D0)', '$1 $2 $3 $4 $5 $6 $7 $8 80'],
        ['(AF|BF)(\\w{2})(FF)(80|C0)(CF|DF)(\\w{2})(FF40)(F0)', '$1 $2 $3 $4 $5 $6 $7 80'],   // Breath of Fire II
        ['(AF|BF)(\\w{4})(30|31|32|33)(CF|DF)(\\w{4})(30|31|32|33)(F0)', '$1 $2 $3 $4 $5 $6 80'], // Breath of Fire II
        ['(8F|AF)(\\w{4})(B0CF)(\\w{4})(B1)(D0)', '$1 $2 $3 $4 $5 EA EA'],                      // Mario no Super Picross
        ['(2638E94812C9AF71)(F0)', '$1 80'],                                                   // Donkey Kong Country 2
        ['(A05C2F7732E9C704)(F0)', '$1 80'],                                                   // Donkey Kong Country 2
        ['(4B4F4E4700F8)(F7)', '$1 F8'],                                                       // Donkey Kong Country 2
        ['(A9C3)(80DD)(FFFF)(F06C)', '$1 F0 CC $3 80 7D'],                                     // Donkey Kong Country 3
        ['(D0F4ABCFAEFF00D0)(01)', '$1 00'],                                                   // Front Mission - Gun Hazard
        ['(1A8FF07F)(31|32)(CFF0)', '$1 30 $3'],                                               // Earthbound
      );

      return findAndReplaceByRegEx(rom, codes, unlock);
    }
  } else {
    if (rom.StringMapMode.includes('LoROM')) {
      codes.push(
        ['(8F|9F)(\\w{4})(70)(CF|DF)(\\w{4})(70)(F0)', '$1 $2 $3 $4 $5 $6 EA EA'],          // Mega Man X
        ['(AF|BF)(\\w{2})(8000)(CF|DF)(\\w{2})(8040)(F0)', '$1 $2 $3 $4 $5 $6 80'],         // Mega Man X
        ['(AF|BF)(\\w{2})(FF)(80|C0)(CF|DF)(\\w{2})(FF40)(F0)', '$1 $2 $3 $4 $5 $6 $7 80'], // Demon's Crest
        ['(8F)(\\w{4})(70AF)(\\w{4})(70C9)(\\w{4})(D0)', '$1 $2 $3 $4 $5 $6 80'],            // Tetris Attack
        ['(C230)(ADCF1F)(C95044D0)', '$1 4C D1 80 $3'],                                     // Tetris Attack
        ['(AF481F00F00CC220B9081C49FFFF1A99081C6BDA5A8D0002)(78F8)(AD220238ED00028D2202)(D858)(22629600)', '$1 80 00 $3 80 00 $5'], // Beavis & Butthead
      );

      return findAndReplaceByRegEx(rom, codes, unlock);
    } else if (rom.StringMapMode.includes('HiROM')) {
      codes.push(
        ['(5C7FD08318FB78C230)', 'EAEAEAEAEAEAEAEAEA'], // Killer Instinct
        ['(22085C10B028)', 'EAEAEAEAEAEA'],             // BS The Legend of Zelda Remix
        ['(DAE230C9)(01)(F018C9)(02)', '$1 09 $3 07'],  // BS The Legend of Zelda Remix
        ['(29FF00C9)(07)(009016)', '$1 00 $3'],         // BS The Legend of Zelda Remix
      );

      return findAndReplaceByRegEx(rom, codes, unlock);
    }
  }

  return false;
}

function removeSlowROMChecks(rom, unlock = true) {
  const codes = [
    ['(A2|A9)(01)(8D|8E)(0D42)', '$1 00 $3 $4'],
    ['(A9)(01)(008D0D42)', '$1 00 $3'],
    ['(A9)(01)(8F0D4200)', '$1 00 $3'],
  ];

  return findAndReplaceByRegEx(rom, codes, unlock);
}

module.exports = {
  formatMbit,
  formatMByte,
  mergeHeader,
  bytesToHex,
  hexToBytes,
  bytesEqual,
  calculateFileSize,
  calculateChecksum,
  calculateInverseChecksum,
  calculateCrc32Hash,
  calculateHash,
  calculateMapModeScore,
  addHeader,
  removeHeader,
  fixChecksum,
  needsInternalROMSizeFix,
  fixInternalROMSize,
  findAndReplaceByRegEx,
  removeRegionChecks,
  removeSRAMChecks,
  removeSlowROMChecks,
};
