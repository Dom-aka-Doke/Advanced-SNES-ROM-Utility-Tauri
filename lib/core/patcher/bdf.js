'use strict';

// Port of Patcher/BDF.cs (bsdiff "BSDIFF40" format, as handled by deltaq's BsPatch)

const bzip2 = require('../helper/bzip2');

function offtin(buf, pos) {
  let y = buf[pos + 7] & 0x7F;
  for (let i = 6; i >= 0; i--) {
    y = y * 256 + buf[pos + i];
  }
  return (buf[pos + 7] & 0x80) ? -y : y;
}

/**
 * @param {Uint8Array} mergedSourceROM ROM incl. SMC header
 * @param {Uint8Array} patch BDF/bsdiff patch file content
 * @returns {Uint8Array|null}
 */
function apply(mergedSourceROM, patch) {
  try {
    if (patch.length < 32) return null;
    if (String.fromCharCode(...patch.subarray(0, 8)) !== 'BSDIFF40') return null;

    const ctrlLen = offtin(patch, 8);
    const diffLen = offtin(patch, 16);
    const newSize = offtin(patch, 24);

    if (ctrlLen < 0 || diffLen < 0 || newSize < 0 || 32 + ctrlLen + diffLen > patch.length) return null;

    const ctrl = bzip2.decompress(patch.subarray(32, 32 + ctrlLen));
    const diff = bzip2.decompress(patch.subarray(32 + ctrlLen, 32 + ctrlLen + diffLen));
    const extra = bzip2.decompress(patch.subarray(32 + ctrlLen + diffLen));

    const oldData = mergedSourceROM;
    const out = new Uint8Array(newSize);

    let oldPos = 0;
    let newPos = 0;
    let ctrlPos = 0;
    let diffPos = 0;
    let extraPos = 0;

    while (newPos < newSize) {
      if (ctrlPos + 24 > ctrl.length) return null;

      const x = offtin(ctrl, ctrlPos);
      const y = offtin(ctrl, ctrlPos + 8);
      const z = offtin(ctrl, ctrlPos + 16);
      ctrlPos += 24;

      if (x < 0 || y < 0 || newPos + x > newSize || diffPos + x > diff.length) return null;

      // Add old data to diff string
      for (let i = 0; i < x; i++) {
        const oldIndex = oldPos + i;
        const oldByte = (oldIndex >= 0 && oldIndex < oldData.length) ? oldData[oldIndex] : 0;
        out[newPos + i] = (diff[diffPos + i] + oldByte) & 0xFF;
      }

      newPos += x;
      oldPos += x;
      diffPos += x;

      if (newPos + y > newSize || extraPos + y > extra.length) return null;

      // Copy extra string
      out.set(extra.subarray(extraPos, extraPos + y), newPos);

      newPos += y;
      extraPos += y;
      oldPos += z;
    }

    return out;
  } catch {
    return null;
  }
}

module.exports = { apply };
