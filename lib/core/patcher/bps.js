'use strict';

// Port of Patcher/BPS.cs

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
 * @param {Uint8Array} patch BPS patch file content
 * @returns {Uint8Array|null}
 */
function apply(mergedSourceROM, crc32Hash, patch) {
  try {
    if (patch.length < 19) return null;
    if (String.fromCharCode(...patch.subarray(0, 4)) !== 'BPS1') return null;

    const state = { pos: 4 };

    const internalHashPatchFile = hexBE(patch, patch.length - 4);
    const internalHashSourceFile = hexBE(patch, patch.length - 12);
    const internalHashDestinationFile = hexBE(patch, patch.length - 8);

    // Validate CRC32 of patch file and source file
    if (internalHashPatchFile !== crc32Hex(patch, 0, patch.length - 4)) return null;
    if (internalHashSourceFile !== crc32Hash) return null;

    const sourceLength = readVWI(patch, state);
    const destinationLength = readVWI(patch, state);
    const metadataLength = readVWI(patch, state);

    if (mergedSourceROM.length !== sourceLength) return null;

    const out = new Uint8Array(destinationLength);

    // Skip metadata
    // (the C# version compared the decoded length with 0x80, which broke patches with exactly 128 bytes of metadata)
    state.pos += metadataLength;

    let outputOffset = 0;
    let sourceRelativeOffset = 0;
    let targetRelativeOffset = 0;
    const end = patch.length - 12;

    while (state.pos < end) {
      const data = readVWI(patch, state);
      const command = data % 4;
      const length = Math.floor(data / 4) + 1;

      switch (command) {
        case 0: // SourceRead
          out.set(mergedSourceROM.subarray(outputOffset, outputOffset + length), outputOffset);
          outputOffset += length;
          break;

        case 1: // TargetRead
          out.set(patch.subarray(state.pos, state.pos + length), outputOffset);
          outputOffset += length;
          state.pos += length;
          break;

        case 2: { // SourceCopy
          const d = readVWI(patch, state);
          sourceRelativeOffset += (d % 2 === 1 ? -1 : 1) * Math.floor(d / 2);
          out.set(mergedSourceROM.subarray(sourceRelativeOffset, sourceRelativeOffset + length), outputOffset);
          outputOffset += length;
          sourceRelativeOffset += length;
          break;
        }

        case 3: { // TargetCopy (byte by byte, regions may overlap)
          const d = readVWI(patch, state);
          targetRelativeOffset += (d % 2 === 1 ? -1 : 1) * Math.floor(d / 2);
          for (let i = 0; i < length; i++) {
            out[outputOffset++] = out[targetRelativeOffset++];
          }
          break;
        }

        default:
          return null;
      }
    }

    if (out.length !== destinationLength) return null;
    if (internalHashDestinationFile !== crc32Hex(out)) return null;

    return out;
  } catch {
    return null;
  }
}

module.exports = { apply };
