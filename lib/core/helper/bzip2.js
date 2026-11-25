'use strict';

// Minimal pure JavaScript bzip2 decompressor (used for BDF / bsdiff patches)
// Replaces the bz2portable.dll / deltaq.dll dependencies of the C# version

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let j = 0; j < 8; j++) {
      c = (c & 0x80000000) ? ((c << 1) ^ 0x04C11DB7) : (c << 1);
    }
    t[i] = c >>> 0;
  }
  return t;
})();

class BitReader {
  constructor(data) {
    this.data = data;
    this.pos = 0;     // byte position
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  bits(n) {
    let result = 0;
    while (n > 0) {
      if (this.bitCount === 0) {
        if (this.pos >= this.data.length) throw new Error('bzip2: unexpected end of data');
        this.bitBuf = this.data[this.pos++];
        this.bitCount = 8;
      }
      const take = Math.min(n, this.bitCount);
      const shift = this.bitCount - take;
      result = (result * (1 << take)) + ((this.bitBuf >> shift) & ((1 << take) - 1));
      this.bitCount -= take;
      n -= take;
    }
    return result;
  }

  bit() {
    return this.bits(1);
  }

  alignToByte() {
    this.bitCount = 0;
  }

  get eof() {
    return this.pos >= this.data.length && this.bitCount === 0;
  }
}

const MAX_CODE_LEN = 20;

function createDecodeTable(lengths, alphaSize) {
  let minLen = 32;
  let maxLen = 0;
  for (let i = 0; i < alphaSize; i++) {
    if (lengths[i] > maxLen) maxLen = lengths[i];
    if (lengths[i] < minLen) minLen = lengths[i];
  }

  const perm = new Int32Array(alphaSize);
  const base = new Int32Array(MAX_CODE_LEN + 2);
  const limit = new Int32Array(MAX_CODE_LEN + 1);

  let pp = 0;
  for (let i = minLen; i <= maxLen; i++) {
    for (let j = 0; j < alphaSize; j++) {
      if (lengths[j] === i) perm[pp++] = j;
    }
  }

  for (let i = 0; i < alphaSize; i++) base[lengths[i] + 1]++;
  for (let i = 1; i < base.length; i++) base[i] += base[i - 1];

  let vec = 0;
  for (let i = minLen; i <= maxLen; i++) {
    vec += base[i + 1] - base[i];
    limit[i] = vec - 1;
    vec <<= 1;
  }
  for (let i = minLen + 1; i <= maxLen; i++) {
    base[i] = ((limit[i - 1] + 1) << 1) - base[i];
  }

  return { minLen, maxLen, perm, base, limit };
}

function decodeSymbol(br, table) {
  let n = table.minLen;
  let code = br.bits(n);
  while (n <= table.maxLen) {
    if (code <= table.limit[n]) {
      return table.perm[code - table.base[n]];
    }
    code = (code << 1) | br.bit();
    n++;
  }
  throw new Error('bzip2: invalid huffman code');
}

function decodeBlock(br, blockSize, out) {
  const blockCRC = br.bits(32) >>> 0;
  const randomized = br.bit();
  if (randomized) throw new Error('bzip2: randomized blocks are not supported');
  const origPtr = br.bits(24);

  // Symbol map
  const seqToUnseq = [];
  const used16 = br.bits(16);
  for (let i = 0; i < 16; i++) {
    if (used16 & (0x8000 >> i)) {
      const bits = br.bits(16);
      for (let j = 0; j < 16; j++) {
        if (bits & (0x8000 >> j)) seqToUnseq.push(i * 16 + j);
      }
    }
  }
  const nInUse = seqToUnseq.length;
  if (nInUse === 0) throw new Error('bzip2: no symbols in use');
  const alphaSize = nInUse + 2;

  // Selectors
  const nGroups = br.bits(3);
  if (nGroups < 2 || nGroups > 6) throw new Error('bzip2: invalid number of huffman groups');
  const nSelectors = br.bits(15);
  if (nSelectors < 1) throw new Error('bzip2: invalid number of selectors');

  const mtfGroups = Array.from({ length: nGroups }, (_, i) => i);
  const selectors = new Uint8Array(nSelectors);
  for (let i = 0; i < nSelectors; i++) {
    let j = 0;
    while (br.bit()) {
      j++;
      if (j >= nGroups) throw new Error('bzip2: invalid selector');
    }
    const v = mtfGroups[j];
    mtfGroups.splice(j, 1);
    mtfGroups.unshift(v);
    selectors[i] = v;
  }

  // Code lengths
  const tables = [];
  for (let t = 0; t < nGroups; t++) {
    const lengths = new Uint8Array(alphaSize);
    let curr = br.bits(5);
    for (let i = 0; i < alphaSize; i++) {
      for (;;) {
        if (curr < 1 || curr > MAX_CODE_LEN) throw new Error('bzip2: invalid code length');
        if (!br.bit()) break;
        curr += br.bit() ? -1 : 1;
      }
      lengths[i] = curr;
    }
    tables.push(createDecodeTable(lengths, alphaSize));
  }

  // MTF / RLE2 decoding
  const EOB = nInUse + 1;
  const tt = new Uint32Array(blockSize);
  const unzftab = new Int32Array(256);
  const yy = new Uint8Array(256);
  for (let i = 0; i < 256; i++) yy[i] = i;

  let nblock = 0;
  let groupNo = -1;
  let groupPos = 0;
  let table = null;

  const nextSym = () => {
    if (groupPos === 0) {
      groupNo++;
      if (groupNo >= nSelectors) throw new Error('bzip2: selector overflow');
      groupPos = 50;
      table = tables[selectors[groupNo]];
    }
    groupPos--;
    return decodeSymbol(br, table);
  };

  let sym = nextSym();

  for (;;) {
    if (sym === EOB) break;

    if (sym === 0 || sym === 1) {
      // RUNA / RUNB
      let es = 0;
      let n = 1;
      do {
        es += (sym === 0 ? 1 : 2) * n;
        n *= 2;
        sym = nextSym();
      } while (sym === 0 || sym === 1);

      const uc = seqToUnseq[yy[0]];
      unzftab[uc] += es;
      if (nblock + es > blockSize) throw new Error('bzip2: block overflow');
      tt.fill(uc, nblock, nblock + es);
      nblock += es;
      continue;
    }

    const nn = sym - 1;
    const v = yy[nn];
    yy.copyWithin(1, 0, nn);
    yy[0] = v;

    const uc = seqToUnseq[v];
    unzftab[uc]++;
    if (nblock >= blockSize) throw new Error('bzip2: block overflow');
    tt[nblock++] = uc;

    sym = nextSym();
  }

  if (origPtr >= nblock) throw new Error('bzip2: invalid origPtr');

  // Inverse BWT
  const cftab = new Int32Array(257);
  for (let i = 0; i < 256; i++) cftab[i + 1] = cftab[i] + unzftab[i];

  for (let i = 0; i < nblock; i++) {
    const uc = tt[i] & 0xFF;
    tt[cftab[uc]] |= (i << 8);
    cftab[uc]++;
  }

  // Output with RLE1 decoding
  let blockOut = new Uint8Array(nblock + 1024);
  let outLen = 0;
  let crc = 0xFFFFFFFF;
  const put = (b) => {
    if (outLen >= blockOut.length) {
      const grown = new Uint8Array(blockOut.length * 2);
      grown.set(blockOut);
      blockOut = grown;
    }
    blockOut[outLen++] = b;
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xFF]) >>> 0;
  };

  let tPos = tt[origPtr] >>> 8;
  let last = -1;
  let runLength = 0;

  for (let k = 0; k < nblock; k++) {
    tPos = tt[tPos];
    const ch = tPos & 0xFF;
    tPos >>>= 8;

    if (runLength === 4) {
      for (let r = 0; r < ch; r++) put(last);
      runLength = 0;
      last = -1;
      continue;
    }

    if (ch === last) {
      runLength++;
    } else {
      runLength = 1;
      last = ch;
    }
    put(ch);
  }

  if (((~crc) >>> 0) !== blockCRC) throw new Error('bzip2: block CRC mismatch');

  out.push(blockOut.subarray(0, outLen));
  return (~crc) >>> 0;
}

/**
 * Decompresses bzip2 data (supports concatenated streams)
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function decompress(data) {
  const br = new BitReader(data);
  const out = [];

  let first = true;
  while (!br.eof) {
    // Skip trailing zero padding after the last stream
    if (!first && br.pos < data.length && data[br.pos] !== 0x42) break;

    if (br.bits(8) !== 0x42 || br.bits(8) !== 0x5A || br.bits(8) !== 0x68) {
      throw new Error('bzip2: invalid signature');
    }
    const level = br.bits(8) - 0x30;
    if (level < 1 || level > 9) throw new Error('bzip2: invalid block size');
    const blockSize = level * 100000;

    let combinedCRC = 0;
    for (;;) {
      const magicHi = br.bits(24);
      const magicLo = br.bits(24);

      if (magicHi === 0x314159 && magicLo === 0x265359) {
        const blockCRC = decodeBlock(br, blockSize, out);
        combinedCRC = (((combinedCRC << 1) | (combinedCRC >>> 31)) ^ blockCRC) >>> 0;
      } else if (magicHi === 0x177245 && magicLo === 0x385090) {
        const streamCRC = br.bits(32) >>> 0;
        if (streamCRC !== combinedCRC) throw new Error('bzip2: stream CRC mismatch');
        br.alignToByte();
        break;
      } else {
        throw new Error('bzip2: invalid block signature');
      }
    }
    first = false;
  }

  const total = out.reduce((n, c) => n + c.length, 0);
  const result = new Uint8Array(total);
  let p = 0;
  for (const c of out) {
    result.set(c, p);
    p += c.length;
  }
  return result;
}

module.exports = { decompress };
