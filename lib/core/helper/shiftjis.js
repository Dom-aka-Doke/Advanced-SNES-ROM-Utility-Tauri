'use strict';

// Shift-JIS (code page 932) encoding/decoding
// The C# version uses Encoding.GetEncoding(932). Node.js / Electron ship with full ICU,
// so decoding is done by TextDecoder. For encoding, a reverse lookup table is built once.

let decoder = null;
let reverseTable = null;

function getDecoder() {
  if (!decoder) {
    decoder = new TextDecoder('shift_jis');
  }
  return decoder;
}

function decode(bytes) {
  return getDecoder().decode(bytes);
}

function buildReverseTable() {
  const map = new Map();
  const dec = getDecoder();

  // Single byte characters (ASCII + half width katakana)
  for (let b = 0x00; b <= 0xFF; b++) {
    const ch = dec.decode(Uint8Array.of(b));
    if (ch.length === 1 && ch !== '�' && !map.has(ch)) {
      map.set(ch, [b]);
    }
  }

  // Double byte characters
  const leadRanges = [[0x81, 0x9F], [0xE0, 0xFC]];
  for (const [from, to] of leadRanges) {
    for (let lead = from; lead <= to; lead++) {
      for (let trail = 0x40; trail <= 0xFC; trail++) {
        if (trail === 0x7F) continue;
        const ch = dec.decode(Uint8Array.of(lead, trail));
        if (ch.length >= 1 && !ch.includes('�') && !map.has(ch)) {
          map.set(ch, [lead, trail]);
        }
      }
    }
  }

  return map;
}

/**
 * Encodes a string into Shift-JIS bytes. Unknown characters become '?' (0x3F) like in .NET.
 * @returns {Uint8Array}
 */
function encode(text) {
  const out = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x80) {
      out.push(code);
      continue;
    }
    if (!reverseTable) {
      reverseTable = buildReverseTable();
    }
    const bytes = reverseTable.get(ch);
    if (bytes) {
      out.push(...bytes);
    } else {
      out.push(0x3F);
    }
  }
  return Uint8Array.from(out);
}

/**
 * Encodes as many whole characters as fit into maxBytes.
 * A double byte character that does not fit completely is left out (never cut in half).
 * @returns {Uint8Array}
 */
function encodeLimited(text, maxBytes) {
  const out = [];
  for (const ch of text) {
    const bytes = encode(ch);
    if (out.length + bytes.length > maxBytes) break;
    out.push(...bytes);
  }
  return Uint8Array.from(out);
}

/** Number of bytes a text needs in Shift-JIS */
function byteLength(text) {
  return encode(text).length;
}

module.exports = { decode, encode, encodeLimited, byteLength };
