'use strict';

// Port of Helper/Crc32.cs (CRC-32, polynomial 0xEDB88320)

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let entry = i;
    for (let j = 0; j < 8; j++) {
      entry = (entry & 1) ? ((entry >>> 1) ^ 0xEDB88320) : (entry >>> 1);
    }
    table[i] = entry >>> 0;
  }
  return table;
})();

/**
 * Calculates the CRC32 of data[start, start + length)
 * @returns {number} unsigned 32 bit CRC
 */
function crc32(data, start = 0, length = data.length - start) {
  let hash = 0xFFFFFFFF;
  const end = start + length;
  for (let i = start; i < end; i++) {
    hash = (hash >>> 8) ^ TABLE[(data[i] ^ hash) & 0xFF];
  }
  return (~hash) >>> 0;
}

/** CRC32 as uppercase hex string with 8 digits (like the C# implementation) */
function crc32Hex(data, start, length) {
  return crc32(data, start, length).toString(16).toUpperCase().padStart(8, '0');
}

module.exports = { crc32, crc32Hex };
