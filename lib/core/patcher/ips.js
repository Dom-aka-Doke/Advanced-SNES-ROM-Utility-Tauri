'use strict';

// Port of Patcher/IPS.cs
// Supports RLE hunks, truncation and avoids the EOF offset bug

const MAGIC = 'PATCH';

function readRecords(patch, endOffset) {
  const records = [];
  let i = MAGIC.length;

  while (i < endOffset) {
    if (i + 5 > patch.length) throw new Error('Unexpected end of IPS patch');

    const offset = (patch[i] << 16) | (patch[i + 1] << 8) | patch[i + 2];
    i += 3;
    let length = (patch[i] << 8) | patch[i + 1];
    i += 2;

    if (length === 0) {
      // RLE hunk
      length = (patch[i] << 8) | patch[i + 1];
      i += 2;
      const value = patch[i];
      i++;
      records.push({ offset, length, rle: true, value });
    } else {
      records.push({ offset, length, rle: false, data: patch.subarray(i, i + length) });
      i += length;
    }
  }

  return records;
}

/**
 * @param {Uint8Array} mergedSourceROM ROM incl. SMC header
 * @param {Uint8Array} patch IPS patch file content
 * @returns {Uint8Array|null}
 */
function apply(mergedSourceROM, patch) {
  // IPS patches must be at least 14 bytes
  if (patch.length < 14) return null;

  // Check magic number
  if (String.fromCharCode(...patch.subarray(0, 5)) !== MAGIC) return null;

  // Check end-of-file marker (optionally followed by 3 byte truncation size)
  const tail = String.fromCharCode(...patch.subarray(patch.length - 6));
  const tailStartsWithEOF = tail.startsWith('EOF');
  if (!tailStartsWithEOF && !tail.endsWith('EOF')) return null;

  let endOffset = patch.length - 3;
  let truncationSize = 0;

  if (tailStartsWithEOF) {
    const p = patch.length - 3;
    truncationSize = (patch[p] << 16) | (patch[p + 1] << 8) | patch[p + 2];
    endOffset -= 3;
  }

  let records;
  try {
    records = readRecords(patch, endOffset);
  } catch {
    return null;
  }

  // Calculate needed size and expand, if necessary
  let neededSize = 0;
  for (const r of records) neededSize = Math.max(neededSize, r.offset + r.length);

  let rom = new Uint8Array(Math.max(mergedSourceROM.length, neededSize));
  rom.set(mergedSourceROM, 0);

  // Patch file
  for (const r of records) {
    if (r.rle) rom.fill(r.value, r.offset, r.offset + r.length);
    else rom.set(r.data, r.offset);
  }

  // Truncate file, if necessary
  if (truncationSize > 0 && truncationSize < rom.length) {
    rom = rom.slice(0, truncationSize);
  }

  return rom;
}

module.exports = { apply };
