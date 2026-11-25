'use strict';

// SNES ROM mirroring
//
// A cartridge only decodes as many address lines as its ROM needs. Addresses beyond the real
// ROM size therefore show data that already exists ("mirror"). For a ROM size that is not a
// power of two (f.e. 12 Mbit = 8 + 4 Mbit) the remainder is mirrored until the next power
// of two is filled: 8 + 4 + 4. This is applied recursively (14 = 8 + 4 + 2 -> 8 + 4 + 2 + 2).
//
// Replaces the Mirror() algorithm of the C# version, which was only correct for remainders
// that are a power of two and for files matching their internal ROM size.

const CHUNK = 0x8000;

/**
 * Returns the address inside a ROM of `size` bytes that `addr` is mirrored from
 * (same algorithm as bsnes' Bus::mirror).
 */
function mirrorAddress(addr, size) {
  if (size === 0) return 0;
  let base = 0;
  let mask = 1 << 30;

  while (addr >= size) {
    while (!(addr & mask)) mask >>>= 1;
    addr -= mask;
    if (size > mask) {
      size -= mask;
      base += mask;
    }
    mask >>>= 1;
  }

  return base + addr;
}

/**
 * Builds the image the SNES sees when `data` is mapped into `targetLength` bytes of address space.
 * If the target is smaller than the data, the data is cut (like a smaller ROM chip would do).
 * @param {Uint8Array} data
 * @param {number} targetLength
 * @returns {Uint8Array}
 */
function mirrorTo(data, targetLength) {
  const out = new Uint8Array(targetLength);
  const size = data.length;

  if (size === 0) return out;

  const copyLength = Math.min(size, targetLength);
  out.set(data.subarray(0, copyLength), 0);

  if (targetLength <= size) return out;

  if (size % CHUNK === 0) {
    // Chunk aligned sizes map whole chunks contiguously
    for (let off = size; off < targetLength; off += CHUNK) {
      const len = Math.min(CHUNK, targetLength - off);
      const src = mirrorAddress(off, size);
      out.set(data.subarray(src, src + len), off);
    }
  } else {
    for (let off = size; off < targetLength; off++) {
      out[off] = data[mirrorAddress(off, size)];
    }
  }

  return out;
}

module.exports = { mirrorAddress, mirrorTo };
