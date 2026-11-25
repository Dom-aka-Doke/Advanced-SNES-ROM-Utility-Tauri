'use strict';

// Ported from Converter/*.cs

const fs = require('fs');
const path = require('path');
const { HeaderOffset, HeaderValue, MapMode } = require('./enums');
const { DeIntPattern20, DeIntPattern24, DeIntPattern48 } = require('./lists/deinterleave');
const { mirrorTo } = require('./helper/mirror');

const MBIT = 131072;

/** Copies src[srcPos, srcPos+len) to dst[dstPos] (bounds safe, like Buffer.BlockCopy) */
function blockCopy(src, srcPos, dst, dstPos, len) {
  if (len <= 0) return;
  const avail = Math.min(len, src.length - srcPos, dst.length - dstPos);
  if (avail <= 0) return;
  if (src === dst) {
    dst.copyWithin(dstPos, srcPos, srcPos + avail);
  } else {
    dst.set(src.subarray(srcPos, srcPos + avail), dstPos);
  }
}

/**
 * Mirrors the ROM data into an address space of `intROMSize` Mbit like the SNES does
 * (see helper/mirror.js). `intCalcFileSize` is kept for compatibility with the C# signature;
 * the real data size is taken from the data itself.
 */
function mirror(sourceROM, intROMSize, intCalcFileSize) {
  return mirrorTo(sourceROM, intROMSize * MBIT);
}

const EXROM_START = 0x400000; // ExLoROM/ExHiROM: data beyond 4 MByte is seen in banks $00-$7D

/**
 * Map modes that are converted to ExLoROM / ExHiROM when expanding beyond 32 Mbit (no enhancement
 * chip with own mapping). Other ROMs can still be expanded beyond 32 Mbit (free space for ROM
 * hacks), but their data and header stay untouched.
 */
function canExpandToExROM(rom) {
  if (rom.IsBSROM || rom.IsInterleaved || rom.isSuperFX) return false;
  const plainLoROM = rom.ByteMapMode === MapMode.lorom_1 || rom.ByteMapMode === MapMode.lorom_2;
  const plainHiROM = rom.ByteMapMode === MapMode.hirom_1 || rom.ByteMapMode === MapMode.hirom_2;
  return plainLoROM || plainHiROM;
}

/**
 * Normalizes the fill option: '00' / 'FF' fill the new space with an empty value
 * (free space for ROM hacks), 'mirror' fills it like the SNES mirrors the data
 * (f.e. to write an 8 Mbit game onto a 16 Mbit EPROM).
 * For compatibility, true/false (old "Mirror ROM on expanding") are accepted as well.
 */
function normalizeFill(fill) {
  if (fill === true || fill === 'mirror') return 'mirror';
  if (fill === 'FF' || fill === 0xFF) return 'FF';
  return '00';
}

/**
 * Expands the ROM to sizeExpandedROM Mbit.
 * @param {'00'|'FF'|'mirror'|boolean} fill how the new space is filled
 */
function expand(rom, sizeExpandedROM, fill = '00') {
  const mode = normalizeFill(fill);
  const fillByte = mode === 'FF' ? 0xFF : 0x00;
  const targetLength = sizeExpandedROM * MBIT;
  const toExROM = targetLength > EXROM_START && rom.SourceROM.length <= EXROM_START && canExpandToExROM(rom);
  const mapModePos = rom.UIntROMHeaderOffset + HeaderValue.mapmode;

  // Area that keeps the game's data: everything, or the first 4 MByte when converting to ExROM
  const lowerLength = toExROM ? EXROM_START : targetLength;
  const expandedROM = new Uint8Array(targetLength).fill(fillByte);

  if (mode === 'mirror') {
    // Fill exactly like the SNES mirrors the real data (real data size, not the header size)
    expandedROM.set(mirrorTo(rom.SourceROM, lowerLength), 0);
  } else {
    blockCopy(rom.SourceROM, 0, expandedROM, 0, rom.SourceROM.length);
  }

  if (toExROM) {
    // In ExLoROM/ExHiROM, banks $80-$FF still show the first 4 MByte, but banks $00-$7D show the
    // new area beyond 4 MByte. Games that run code via $00-$3F would crash, so the parts the CPU
    // reaches there are copied. Everything else in the new area stays free space.
    // (The C# version only copied the first bank without mirroring.)
    const dataLength = mode === 'mirror' ? lowerLength : rom.SourceROM.length;

    if (rom.StringMapMode.startsWith('LoROM')) {
      if (rom.ByteMapMode >= 0x30) {
        expandedROM[mapModePos] = MapMode.exlorom;
      }
      // $00-$7D:8000-FFFF -> ROM $400000+ in 32 kByte banks: one to one copy of the LoROM data
      const length = Math.min(dataLength, targetLength - EXROM_START);
      blockCopy(expandedROM, 0, expandedROM, EXROM_START, length);
    } else if (rom.StringMapMode.startsWith('HiROM')) {
      expandedROM[mapModePos] = (rom.ByteROMSpeed | 0x05) & 0xFF;
      // $00-$3F:8000-FFFF -> upper halves of the 64 kByte banks at $400000+
      for (let bank = 0; bank * 0x10000 < dataLength; bank++) {
        const dst = EXROM_START + bank * 0x10000 + 0x8000;
        if (dst >= targetLength) break;
        blockCopy(expandedROM, bank * 0x10000 + 0x8000, expandedROM, dst, 0x8000);
      }
    }
  }

  rom.SourceROM = expandedROM;
  rom.initialize(['romheader', 'mapmode', 'romsize', 'checksum', 'filesize']);
}

/** Splits the ROM into equal parts. Returns the list of written files. */
function split(rom, splitROMSize) {
  const partSize = splitROMSize * MBIT;
  const romChunks = Math.trunc(rom.SourceROM.length / partSize);
  const written = [];

  for (let index = 0; index < romChunks; index++) {
    const name = `${rom.ROMName}_[${index}]_[split].bin`;
    const filePath = path.join(rom.ROMFolder, name);
    fs.writeFileSync(filePath, rom.SourceROM.subarray(index * partSize, (index + 1) * partSize));
    written.push(filePath);
  }

  return written;
}

function swapBinChunk(sourceROM, romFolder, romName) {
  const swapped = new Uint8Array(sourceROM);

  const swapSrcAdds = [65536, 131072, 262144, 524288, 393216, 196608, 786432, 589824, 458752, 851968, 720896, 917504];
  const swapDstAdds = [262144, 524288, 65536, 131072, 589824, 786432, 196608, 393216, 851968, 458752, 917504, 720896];
  const swapSize = 65536;

  swapSrcAdds.forEach((src, i) => {
    blockCopy(sourceROM, src, swapped, swapDstAdds[i], swapSize);
  });

  const filePath = path.join(romFolder, `${romName}_[swapped].bin`);
  fs.writeFileSync(filePath, swapped);
  return filePath;
}

/** SwapBin for 27C801 EPROMs. Returns the list of written files. */
function swapBin(rom) {
  const chunkSize = 1048576;
  const written = [];

  // Check if ROM is multiple of 8 MBit, otherwise swapping is not possible
  if (rom.SourceROM.length % chunkSize !== 0) return written;

  const romChunks = rom.SourceROM.length / chunkSize;

  if (romChunks > 1) {
    for (let index = 0; index < romChunks; index++) {
      const chunk = rom.SourceROM.subarray(index * chunkSize, (index + 1) * chunkSize);
      written.push(swapBinChunk(chunk, rom.ROMFolder, `${rom.ROMName}_[${index}]`));
    }
  } else {
    written.push(swapBinChunk(rom.SourceROM, rom.ROMFolder, rom.ROMName));
  }

  return written;
}

const ascii = (bytes) => String.fromCharCode(...bytes);

/**
 * Determines the interleave pattern for 20/24/48 Mbit ROMs.
 * @param {function(string): string} chooseCopier callback returning 'gd' | 'ufo' | 'standard' | 'cancel'
 * @returns {{cancel: boolean, pattern: number[]|null}}
 */
function getInterleavePattern(rom, chooseCopier, text) {
  let pattern = null;

  if (rom.IntCalcFileSize === 20 || rom.IntCalcFileSize === 24 || rom.IntCalcFileSize === 48) {
    let ufo = false; // Super UFO
    let gd = false;  // Game Doctor SF

    if (rom.SourceROMSMCHeader != null) {
      // Analyze SMC header
      const hdr = rom.SourceROMSMCHeader;
      if (hdr.length >= 16 && ascii(hdr.subarray(8, 16)) === 'SUPERUFO') ufo = true;
      if (hdr.length >= 14 && ascii(hdr.subarray(0, 14)) === 'GAME DOCTOR SF') gd = true;
    } else {
      // No header: ask user how to proceed
      const choice = chooseCopier ? chooseCopier(text) : 'standard';
      if (choice === 'gd') gd = true;
      else if (choice === 'ufo') ufo = true;
      else if (choice === 'cancel') return { cancel: true, pattern: null };
    }

    if (!ufo && rom.IntCalcFileSize === 20) pattern = DeIntPattern20;
    else if (!ufo && rom.IntCalcFileSize === 24) pattern = DeIntPattern24;
    else if (gd && rom.IntCalcFileSize === 48) pattern = DeIntPattern48;
  }

  return { cancel: false, pattern };
}

const DEINTERLEAVE_TEXT =
  'ROM file has no or an unknown copier header and a file size of 20, 24 or 48 MBit.\n\n' +
  'In this case, deinterleaving requires the specification of a source format.\n\n' +
  'You now can go on by selecting a supported copier format or use standard deinterleaving.\n\n' +
  "Do this at your own risk! Don't proceed if you don't know exactly what you're doing!\n\n" +
  'Always verify your ROM by loading it in an emulator!';

const INTERLEAVE_TEXT =
  'ROM file has no or an unknown copier header and a file size of 20, 24 or 48 MBit.\n\n' +
  'In this case, interleaving requires the specification of a target format.\n\n' +
  'You now can go on by selecting a supported copier format or use standard interleaving.\n\n' +
  "Do this at your own risk! Don't proceed if you don't know exactly what you're doing!\n\n" +
  'Always verify your ROM by loading it in an emulator!';

/** @returns {boolean} false if cancelled by user */
function deinterleave(rom, chooseCopier) {
  const { cancel, pattern } = getInterleavePattern(rom, chooseCopier, DEINTERLEAVE_TEXT);
  if (cancel) return false;

  const src = rom.SourceROM;
  const out = new Uint8Array(src.length);
  const chunkSize = 32768;
  const chunkItems = Math.trunc(src.length / chunkSize);

  if (pattern) {
    for (let c = 0; c < chunkItems && c < pattern.length; c++) {
      blockCopy(src, c * chunkSize, out, pattern[c] * chunkSize, chunkSize);
    }
  } else {
    let even = 0;
    let odd = 1;
    const half = Math.trunc((rom.IntCalcFileSize * MBIT) / 2);

    for (let c = 0; c < chunkItems; c++) {
      const sourcePos = c * chunkSize;
      if (sourcePos < half) {
        blockCopy(src, sourcePos, out, odd * chunkSize, chunkSize);
        odd += 2;
      } else {
        blockCopy(src, sourcePos, out, even * chunkSize, chunkSize);
        even += 2;
      }
    }
  }

  rom.SourceROM = out;
  rom.initialize(['smcheader', 'romheader', 'mapmode', 'checksum']);
  return true;
}

/** @returns {boolean} false if cancelled by user */
function interleave(rom, chooseCopier) {
  const { cancel, pattern } = getInterleavePattern(rom, chooseCopier, INTERLEAVE_TEXT);
  if (cancel) return false;

  const src = rom.SourceROM;
  const out = new Uint8Array(src.length);
  const chunkSize = 32768;
  const chunkItems = Math.trunc(src.length / chunkSize);

  if (pattern) {
    for (let c = 0; c < chunkItems && c < pattern.length; c++) {
      blockCopy(src, pattern[c] * chunkSize, out, c * chunkSize, chunkSize);
    }
  } else {
    const half = Math.trunc((rom.IntCalcFileSize * MBIT) / 2);
    for (let c = 0; c < chunkItems; c++) {
      let destPos = Math.trunc(c / 2) * chunkSize;
      if (c % 2 === 0) destPos += half;
      blockCopy(src, c * chunkSize, out, destPos, chunkSize);
    }
  }

  rom.SourceROM = out;
  rom.initialize(['smcheader', 'romheader', 'mapmode', 'checksum']);
  return true;
}

function canConvertMapMode(rom) {
  if (rom.IsInterleaved) return false;
  const m = rom.ByteMapMode;
  return m === MapMode.lorom_1 || m === MapMode.lorom_2 ||
    m === MapMode.hirom_1 || m === MapMode.hirom_2 || m === MapMode.hirom_spc7110;
}

/** @returns {boolean} true if converted */
function convertMapMode(rom) {
  const src = rom.SourceROM;
  let converted = null;

  if (!rom.IsInterleaved && (rom.ByteMapMode === MapMode.lorom_1 || rom.ByteMapMode === MapMode.lorom_2)) {
    // LoROM -> HiROM (https://github.com/danielburgess/LoHiROM)
    converted = new Uint8Array(src.length * 2);
    const chunkSize = 32768;
    const chunks = Math.trunc(src.length / chunkSize);

    for (let c = 0; c < chunks; c++) {
      const sourcePos = c * chunkSize;
      const newPos = c * 65536;
      if (c === 0) {
        converted.fill(0xFF, newPos, newPos + chunkSize);
      } else {
        converted.set(src.subarray(sourcePos, sourcePos + chunkSize), newPos);
      }
      converted.set(src.subarray(sourcePos, sourcePos + chunkSize), newPos + chunkSize);
    }

    converted[HeaderOffset.hirom + HeaderValue.mapmode] = MapMode.hirom_1;
  } else if (!rom.IsInterleaved && (rom.ByteMapMode === MapMode.hirom_1 || rom.ByteMapMode === MapMode.hirom_2 || rom.ByteMapMode === MapMode.hirom_spc7110)) {
    // HiROM -> LoROM (https://github.com/pimaster/LoHiROM/blob/Allow-High-to-Low-conversion)
    converted = new Uint8Array(Math.trunc(src.length / 2));
    const chunkSize = 65536;
    const chunks = Math.trunc(src.length / chunkSize);

    for (let c = 0; c < chunks; c++) {
      const sourcePos = c === 0 ? 32768 : c * chunkSize;
      converted.set(src.subarray(sourcePos, sourcePos + 32768), c * 32768);
    }

    converted[HeaderOffset.lorom + HeaderValue.mapmode] = MapMode.lorom_1;
  }

  if (!converted) return false;

  rom.SourceROM = converted;
  rom.initialize(['romheader', 'mapmode', 'romsize', 'checksum', 'filesize']);
  return true;
}

module.exports = {
  blockCopy,
  canExpandToExROM,
  normalizeFill,
  mirror,
  expand,
  split,
  swapBin,
  deinterleave,
  interleave,
  canConvertMapMode,
  convertMapMode,
};
