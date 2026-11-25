'use strict';

// Port of Patcher/UPS.cs
// Supports reverting a patch, if applied a second time

const { crc32Hex } = require('../helper/crc32');

function readVWI(buf, state) {
  let data = 0;
  let shift = 1;
  let x = buf[state.pos];
  data += (x & 0x7F) * shift;

  while ((x & 0x80) === 0) {
    shift *= 128;
    data += shift;
    state.pos++;
    if (state.pos >= buf.length) throw new Error('Invalid VWI');
    x = buf[state.pos];
    data += (x & 0x7F) * shift;
  }

  state.pos++;
  return data;
}

const hexBE = (buf, pos) => Array.from(buf.subarray(pos, pos + 4)).reverse()
  .map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');

/**
 * @param {Uint8Array} mergedSourceROM ROM incl. SMC header
 * @param {string} crc32Hash CRC32 of mergedSourceROM (uppercase hex)
 * @param {Uint8Array} patch UPS patch file content
 * @returns {Uint8Array|null}
 */
function apply(mergedSourceROM, crc32Hash, patch) {
  try {
    if (patch.length < 19) return null;
    if (String.fromCharCode(...patch.subarray(0, 4)) !== 'UPS1') return null;

    const state = { pos: 4 };

    // Verify CRC32 of patch file
    const internalHashPatchFile = hexBE(patch, patch.length - 4);
    if (internalHashPatchFile !== crc32Hex(patch, 0, patch.length - 4)) return null;

    // Verify size of source file
    const sourceLength = readVWI(patch, state);
    const destinationLength = readVWI(patch, state);
    if (mergedSourceROM.length !== sourceLength && mergedSourceROM.length !== destinationLength) return null;

    // Verify CRC32 of source file
    const internalHashSourceFile = hexBE(patch, patch.length - 12);
    const internalHashDestinationFile = hexBE(patch, patch.length - 8);
    if (internalHashSourceFile !== crc32Hash && internalHashDestinationFile !== crc32Hash) return null;

    // Create destination file for patching
    let newLength = mergedSourceROM.length;
    if (internalHashSourceFile === crc32Hash) newLength = destinationLength;
    else if (internalHashDestinationFile === crc32Hash) newLength = sourceLength;

    const rom = new Uint8Array(newLength);
    rom.set(mergedSourceROM.subarray(0, Math.min(newLength, mergedSourceROM.length)), 0);

    // Generate patched file using VWI information
    const end = patch.length - 12;
    let offsetSource = 0;

    while (state.pos < end) {
      offsetSource += readVWI(patch, state);

      while (patch[state.pos] !== 0x00 && offsetSource < rom.length) {
        rom[offsetSource] ^= patch[state.pos];
        offsetSource++;
        state.pos++;
      }

      offsetSource++;
      state.pos++;
    }

    // Verify size of destination file
    if (rom.length !== destinationLength && rom.length !== sourceLength) return null;

    // Verify CRC32 of the result: target file when patching, source file when reverting
    // (the C# version did not verify the result of a revert)
    const resultHash = crc32Hex(rom);
    const reverting = internalHashSourceFile !== crc32Hash;
    if (reverting ? resultHash !== internalHashSourceFile : resultHash !== internalHashDestinationFile) return null;

    return rom;
  } catch {
    return null;
  }
}

module.exports = { apply };
