'use strict';

// ROM analysis: overdump detection/removal and bank map (duplicate banks)

const crypto = require('crypto');
const { HeaderOffset } = require('./enums');
const { mirrorAddress } = require('./helper/mirror');

/** Compares data[a, a+len) with data[b, b+len) (replacement for Buffer.compare, also runs in browsers) */
function sameBytes(data, a, b, len) {
  for (let i = 0; i < len; i++) {
    if (data[a + i] !== data[b + i]) return false;
  }
  return true;
}

const MBIT = 0x20000;     // 1 Mbit = 128 kByte
const CHUNK = 0x8000;     // granularity for mirror compares

/** True if everything from `size` on is a mirror of the first `size` bytes */
function isMirrorBeyond(rom, size) {
  for (let off = size; off < rom.length; off += CHUNK) {
    const len = Math.min(CHUNK, rom.length - off);
    const src = mirrorAddress(off, size);
    if (!sameBytes(rom, off, src, len)) {
      return false;
    }
  }
  return true;
}

/** Returns 0x00 / 0xFF if the range only contains that value, otherwise null */
function fillValue(rom, start, end) {
  if (start >= end) return null;
  const v = rom[start];
  if (v !== 0x00 && v !== 0xFF) return null;
  for (let i = start + 1; i < end; i++) {
    if (rom[i] !== v) return null;
  }
  return v;
}

const MIN_BANK = 0x8000; // 32 kByte: smallest ROM (homebrew / test ROMs)

/** Sizes a ROM can really have: 32 / 64 kByte for tiny ROMs, then every whole Mbit */
function* candidateSizes(minSize, fileSize) {
  for (let size = minSize; size < MBIT && size < fileSize; size *= 2) yield size;
  for (let size = Math.max(MBIT, Math.ceil(minSize / MBIT) * MBIT); size < fileSize; size += MBIT) yield size;
}

/**
 * Detects overdumps:
 * - "mirror":  the end of the file is a mirror of a smaller ROM (f.e. 4 Mbit game dumped as 8 Mbit,
 *              or 12 Mbit game dumped as 16 Mbit with the last 4 Mbit repeated)
 * - "padding": the file is larger than the internal ROM size and the excess is filled with 0x00/0xFF
 *
 * @param {import('./snesrom').SNESROM} rom
 * @returns {{supported: boolean, overdump: boolean, type?: string, realSize?: number,
 *            fileSize: number, internalSize: number, reason?: string}}
 */
function detectOverdump(rom) {
  const data = rom.SourceROM;
  const fileSize = data.length;
  const internalSize = rom.IntROMSize * MBIT;
  const result = { supported: true, overdump: false, fileSize, internalSize };

  if (rom.IsInterleaved) {
    return { ...result, supported: false, reason: 'Interleaved ROMs have to be deinterleaved first.' };
  }

  // The (copied) internal header must stay inside the ROM
  let headerEnd = rom.UIntROMHeaderOffset + 0x50;
  if (rom.IsExROMHeaderCopied) headerEnd = Math.max(headerEnd, rom.UIntROMHeaderCopyOffset + 0x50);
  // Smallest real size: one LoROM bank (32 kByte) or whatever holds the header
  const minSize = Math.max(MIN_BANK, Math.ceil(headerEnd / MIN_BANK) * MIN_BANK);

  // 1) Padding beyond the internal ROM size (0x00/0xFF). Padding is never trimmed below the
  //    internal size, because games may contain unused (filled) space inside their real ROM size.
  if (internalSize >= minSize && fileSize > internalSize) {
    const fill = fillValue(data, internalSize, fileSize);
    if (fill !== null) {
      return { ...result, overdump: true, type: 'padding', fill, realSize: internalSize };
    }
  }

  // 2) Mirrored data: smallest ROM size whose mirror explains the whole file.
  //    Sizes where the rest of the file is only 0x00/0xFF are skipped - a filled area
  //    "mirrors" itself and would otherwise be mistaken for real data.
  for (const size of candidateSizes(minSize, fileSize)) {
    if (fillValue(data, size, fileSize) !== null) continue;
    if (isMirrorBeyond(data, size)) {
      return { ...result, overdump: true, type: 'mirror', realSize: size };
    }
  }

  return result;
}

/**
 * Removes a detected overdump.
 * @returns {object|null} detection result that was applied, or null if there was nothing to remove
 */
function removeOverdump(rom) {
  const info = detectOverdump(rom);
  if (!info.supported || !info.overdump) return null;

  rom.SourceROM = rom.SourceROM.slice(0, info.realSize);
  rom.initialize(['romheader', 'mapmode', 'romsize', 'checksum', 'filesize']);
  return info;
}

/** Default bank size for the ROM's map mode: 32 kByte for LoROM, 64 kByte for HiROM */
function defaultBankSize(rom) {
  const hi = rom.UIntROMHeaderOffset === HeaderOffset.hirom || rom.UIntROMHeaderOffset === HeaderOffset.exhirom;
  return hi && !rom.IsInterleaved ? 0x10000 : 0x8000;
}

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

/** SNES CPU address of a file offset (start of a bank) */
function snesAddress(rom, offset, bankSize) {
  const off = rom.UIntROMHeaderOffset;
  const isHi = off === HeaderOffset.hirom || off === HeaderOffset.exhirom;

  if (isHi && bankSize === 0x10000) {
    const bank = offset >>> 16;
    // ExHiROM: first 4 MByte at $C0-$FF, rest at $40-$7D
    if (off === HeaderOffset.exhirom) {
      return bank < 0x40 ? `$${hex2(0xC0 + bank)}:0000` : `$${hex2(bank)}:0000`;
    }
    return `$${hex2(0xC0 + (bank & 0x3F))}:0000`;
  }

  if (!isHi && bankSize === 0x8000) {
    const bank = offset >>> 15;
    // ExLoROM: first 4 MByte at $80-$FF, rest at $00-$7D
    if (off === HeaderOffset.exlorom) {
      return bank < 0x80 ? `$${hex2(0x80 + bank)}:8000` : `$${hex2(bank - 0x80)}:8000`;
    }
    return `$${hex2(bank & 0x7F)}:8000`;
  }

  return '';
}

function entropy(bytes) {
  const counts = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i++) counts[bytes[i]]++;
  let e = 0;
  for (let i = 0; i < 256; i++) {
    if (counts[i]) {
      const p = counts[i] / bytes.length;
      e -= p * Math.log2(p);
    }
  }
  return e; // 0 - 8 bits per byte
}

/**
 * Splits the ROM into banks and finds identical banks.
 * @param {number} [bankSize] 0x8000 (LoROM) or 0x10000 (HiROM); default depends on the map mode
 */
function analyzeBanks(rom, bankSize) {
  const size = bankSize || defaultBankSize(rom);
  const data = rom.SourceROM;
  const count = Math.ceil(data.length / size);
  const headerOffsets = [rom.UIntROMHeaderOffset];
  if (rom.IsExROMHeaderCopied) headerOffsets.push(rom.UIntROMHeaderCopyOffset);

  const byHash = new Map();
  const banks = [];

  for (let i = 0; i < count; i++) {
    const start = i * size;
    const end = Math.min(start + size, data.length);
    const bytes = data.subarray(start, end);
    const hash = crypto.createHash('sha1').update(bytes).digest('hex');
    const fill = fillValue(data, start, end);

    const bank = {
      index: i,
      offset: start,
      length: end - start,
      snes: snesAddress(rom, start, size),
      fill,
      entropy: Math.round(entropy(bytes) * 100) / 100,
      header: headerOffsets.some((h) => h >= start && h < end),
      duplicateOf: null,
      group: null,
    };

    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(i);
    banks.push(bank);
  }

  // Groups of identical banks (filled banks are reported as empty, not as duplicates)
  const groups = [];
  for (const members of byHash.values()) {
    if (members.length < 2 || banks[members[0]].fill !== null) continue;
    const id = groups.length;
    groups.push({ id, banks: members });
    for (const m of members) {
      banks[m].group = id;
      banks[m].duplicateOf = m === members[0] ? null : members[0];
    }
  }

  const inGroups = banks.filter((b) => b.group !== null).length;
  const copies = banks.filter((b) => b.duplicateOf !== null).length;
  const emptyBanks = banks.filter((b) => b.fill !== null).length;

  return {
    bankSize: size,
    romSize: data.length,
    mapMode: rom.StringMapMode,
    banks,
    groups,
    summary: {
      banks: count,
      unique: count - inGroups - emptyBanks, // banks without any identical bank
      duplicates: inGroups,                  // banks that exist more than once (originals and copies)
      copies,                                // redundant copies
      groups: groups.length,
      empty: emptyBanks,
    },
  };
}

module.exports = {
  MBIT,
  mirrorAddress,
  detectOverdump,
  removeOverdump,
  defaultBankSize,
  analyzeBanks,
};
