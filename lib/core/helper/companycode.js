'use strict';

// Transformation between the internal company code (key of lists/company.js) and the
// bytes stored in the ROM header.
//
// Old header ($FFDA != 0x33): one byte at $FFDA, code = high nibble * 36 + low nibble
//                              (the byte's hex notation read as base 36, f.e. 0xA4 -> "A4" -> 10 * 36 + 4)
// New header ($FFDA == 0x33): two ASCII chars ("maker code") at $FFB0, code = c0 * 36 + c1
//                              with '0'-'9' = 0-9 and 'A'-'Z' = 10-35
//
// Decoding replicates the byte arithmetic of the C# version (values wrap around at 256),
// so that homebrew maker codes with unusual characters get the same codes as before.

const NEW_HEADER_MARKER = 0x33;

/** Decodes one maker code character like SNESROM.GetCompany() in the C# version */
function decodeChar(b) {
  return (b > 0x39 ? b - 0x37 : b - 0x30) & 0xFF;
}

/** Inverse of decodeChar(); returns null if no byte produces this digit value */
function encodeChar(d) {
  if (d < 0 || d > 0xFF) return null;
  if (d <= 9) return 0x30 + d;          // '0'-'9'
  if (d <= 0xC8) return d + 0x37;       // 'A'-'Z' and beyond
  if (d >= 0xD0) return d - 0xD0;       // wrap around (bytes 0x00-0x2F)
  return null;                          // 0xC9-0xCF cannot be produced
}

function decodeOld(byte) {
  return ((byte >> 4) & 0x0F) * 36 + (byte & 0x0F);
}

function decodeNew(b0, b1) {
  return decodeChar(b0) * 36 + decodeChar(b1);
}

/**
 * Old header: code -> single byte. Only codes whose base 36 digits are 0-15 are possible,
 * and 0x33 is reserved as marker for the extended header.
 * @returns {number|null}
 */
function encodeOld(code) {
  if (!Number.isInteger(code) || code < 0) return null;
  const hi = Math.floor(code / 36);
  const lo = code % 36;
  if (hi > 0x0F || lo > 0x0F) return null;
  const byte = (hi << 4) | lo;
  return byte === NEW_HEADER_MARKER ? null : byte;
}

/**
 * New header: code -> two maker code bytes. Prefers the regular notation ('0'-'9', 'A'-'Z').
 * @returns {Uint8Array|null}
 */
function encodeNew(code) {
  if (!Number.isInteger(code) || code < 0) return null;

  // Regular split first (second digit 0-35), then alternatives with larger second digit
  for (let c0 = Math.floor(code / 36); c0 >= 0; c0--) {
    const c1 = code - c0 * 36;
    if (c1 > 0xFF) break;
    const b0 = encodeChar(c0);
    const b1 = encodeChar(c1);
    if (b0 !== null && b1 !== null && c0 <= 0xFF) {
      return Uint8Array.of(b0, b1);
    }
  }
  return null;
}

/** Text shown for the code as stored in the header, f.e. "A4" */
function headerNotation(code, isNewHeader) {
  if (isNewHeader) {
    const bytes = encodeNew(code);
    if (!bytes) return '??';
    return Array.from(bytes, (b) => (b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`)).join('');
  }
  const byte = encodeOld(code);
  return byte === null ? '??' : byte.toString(16).toUpperCase().padStart(2, '0');
}

/** Key of lists/company.js, f.e. 0x016C -> "0x016C" */
function codeKey(code) {
  return '0x' + (code >>> 0).toString(16).toUpperCase().padStart(4, '0');
}

module.exports = {
  NEW_HEADER_MARKER,
  decodeChar,
  encodeChar,
  decodeOld,
  decodeNew,
  encodeOld,
  encodeNew,
  headerNotation,
  codeKey,
};
