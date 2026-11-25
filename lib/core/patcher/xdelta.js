'use strict';

// Port of Patcher/XDELTA.cs
// The C# version uses the native xdelta3.dll. This is a pure JavaScript VCDIFF (RFC 3284)
// decoder incl. the xdelta3 extensions (application header, Adler-32 window checksums).
// Secondary compression (xdelta3 -S djw/fgk/lzma) is not supported.

const VCD_SOURCE = 0x01;
const VCD_TARGET = 0x02;
const VCD_ADLER32 = 0x04;

const VCD_DECOMPRESS = 0x01;
const VCD_CODETABLE = 0x02;
const VCD_APPHEADER = 0x04;

const NOOP = 0;
const ADD = 1;
const RUN = 2;
const COPY = 3;

class XdeltaError extends Error {}

/** Builds the default code table from RFC 3284 section 5.6 */
function buildDefaultCodeTable() {
  const table = [];
  const entry = (type1, size1, mode1, type2, size2, mode2) => table.push({ type1, size1, mode1, type2, size2, mode2 });

  entry(RUN, 0, 0, NOOP, 0, 0);
  for (let size = 0; size <= 17; size++) entry(ADD, size, 0, NOOP, 0, 0);

  for (let mode = 0; mode <= 8; mode++) {
    entry(COPY, 0, mode, NOOP, 0, 0);
    for (let size = 4; size <= 18; size++) entry(COPY, size, mode, NOOP, 0, 0);
  }

  for (let mode = 0; mode <= 5; mode++) {
    for (let addSize = 1; addSize <= 4; addSize++) {
      for (let copySize = 4; copySize <= 6; copySize++) entry(ADD, addSize, 0, COPY, copySize, mode);
    }
  }

  for (let mode = 6; mode <= 8; mode++) {
    for (let addSize = 1; addSize <= 4; addSize++) entry(ADD, addSize, 0, COPY, 4, mode);
  }

  for (let mode = 0; mode <= 8; mode++) entry(COPY, 4, mode, ADD, 1, 0);

  return table;
}

const CODE_TABLE = buildDefaultCodeTable();

class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }

  byte() {
    if (this.pos >= this.end) throw new XdeltaError('Unexpected end of xdelta data');
    return this.buf[this.pos++];
  }

  int() {
    let value = 0;
    for (let i = 0; i < 10; i++) {
      const b = this.byte();
      value = value * 128 + (b & 0x7F);
      if ((b & 0x80) === 0) return value;
    }
    throw new XdeltaError('Invalid integer in xdelta data');
  }

  bytes(n) {
    if (this.pos + n > this.end) throw new XdeltaError('Unexpected end of xdelta data');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

class AddressCache {
  constructor(nearSize = 4, sameSize = 3) {
    this.nearSize = nearSize;
    this.sameSize = sameSize;
    this.reset();
  }

  reset() {
    this.near = new Array(this.nearSize).fill(0);
    this.nextSlot = 0;
    this.same = new Array(this.sameSize * 256).fill(0);
  }

  update(addr) {
    if (this.nearSize > 0) {
      this.near[this.nextSlot] = addr;
      this.nextSlot = (this.nextSlot + 1) % this.nearSize;
    }
    if (this.sameSize > 0) {
      this.same[addr % (this.sameSize * 256)] = addr;
    }
  }

  decode(here, mode, addrReader) {
    let addr;
    if (mode === 0) {
      addr = addrReader.int();
    } else if (mode === 1) {
      addr = here - addrReader.int();
    } else if (mode - 2 < this.nearSize) {
      addr = this.near[mode - 2] + addrReader.int();
    } else {
      const m = mode - (2 + this.nearSize);
      addr = this.same[m * 256 + addrReader.byte()];
    }
    this.update(addr);
    return addr;
  }
}

function adler32(data, start, end) {
  let a = 1;
  let b = 0;
  for (let i = start; i < end; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * @param {Uint8Array} mergedSourceROM ROM incl. SMC header
 * @param {Uint8Array} patch xdelta/VCDIFF patch content
 * @returns {Uint8Array|null}
 */
function decode(source, patch) {
  const r = new Reader(patch);

  if (r.byte() !== 0xD6 || r.byte() !== 0xC3 || r.byte() !== 0xC4) {
    throw new XdeltaError('Not a VCDIFF/xdelta file');
  }
  r.byte(); // version

  const hdrIndicator = r.byte();

  if (hdrIndicator & VCD_DECOMPRESS) {
    throw new XdeltaError('xdelta patches with secondary compression are not supported');
  }

  if (hdrIndicator & VCD_CODETABLE) {
    throw new XdeltaError('xdelta patches with custom code tables are not supported');
  }

  if (hdrIndicator & VCD_APPHEADER) {
    const len = r.int();
    r.bytes(len);
  }

  const chunks = [];
  let totalLength = 0;
  const cache = new AddressCache();

  // Output so far (needed for VCD_TARGET windows)
  const getOutput = () => {
    const out = new Uint8Array(totalLength);
    let p = 0;
    for (const c of chunks) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  };

  while (r.pos < patch.length) {
    const winIndicator = r.byte();
    let sourceSegment = new Uint8Array(0);

    if (winIndicator & (VCD_SOURCE | VCD_TARGET)) {
      const segLen = r.int();
      const segPos = r.int();

      if (winIndicator & VCD_SOURCE) {
        if (segPos + segLen > source.length) throw new XdeltaError('Source window out of range');
        sourceSegment = source.subarray(segPos, segPos + segLen);
      } else {
        const out = getOutput();
        if (segPos + segLen > out.length) throw new XdeltaError('Target window out of range');
        sourceSegment = out.slice(segPos, segPos + segLen);
      }
    }

    r.int(); // length of the delta encoding
    const targetLength = r.int();
    const deltaIndicator = r.byte();

    if (deltaIndicator !== 0) {
      throw new XdeltaError('xdelta patches with secondary compression are not supported');
    }

    const dataLen = r.int();
    const instLen = r.int();
    const addrLen = r.int();

    let checksum = null;
    if (winIndicator & VCD_ADLER32) {
      const c = r.bytes(4);
      checksum = ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) >>> 0;
    }

    const dataReader = new Reader(patch, r.pos, r.pos + dataLen);
    const instReader = new Reader(patch, r.pos + dataLen, r.pos + dataLen + instLen);
    const addrReader = new Reader(patch, r.pos + dataLen + instLen, r.pos + dataLen + instLen + addrLen);
    r.pos += dataLen + instLen + addrLen;

    if (r.pos > patch.length) throw new XdeltaError('Unexpected end of xdelta data');

    const target = new Uint8Array(targetLength);
    const srcLen = sourceSegment.length;
    let tPos = 0;
    cache.reset();

    const execute = (type, size, mode) => {
      if (type === NOOP) return;
      if (size === 0) size = instReader.int();
      if (tPos + size > targetLength) throw new XdeltaError('Target window overflow');

      switch (type) {
        case ADD:
          target.set(dataReader.bytes(size), tPos);
          tPos += size;
          break;

        case RUN:
          target.fill(dataReader.byte(), tPos, tPos + size);
          tPos += size;
          break;

        case COPY: {
          const addr = cache.decode(srcLen + tPos, mode, addrReader);
          if (addr < 0 || addr >= srcLen + tPos) throw new XdeltaError('Invalid copy address');

          for (let i = 0; i < size; i++) {
            const a = addr + i;
            target[tPos + i] = a < srcLen ? sourceSegment[a] : target[a - srcLen];
          }
          tPos += size;
          break;
        }

        default:
          throw new XdeltaError('Invalid instruction');
      }
    };

    while (instReader.pos < instReader.end) {
      const code = CODE_TABLE[instReader.byte()];
      execute(code.type1, code.size1, code.mode1);
      execute(code.type2, code.size2, code.mode2);
    }

    if (tPos !== targetLength) throw new XdeltaError('Target window size mismatch');

    if (checksum !== null && adler32(target, 0, targetLength) !== checksum) {
      throw new XdeltaError('Checksum mismatch (patch does not fit this ROM?)');
    }

    chunks.push(target);
    totalLength += targetLength;
  }

  return getOutput();
}

function apply(mergedSourceROM, patch) {
  try {
    return decode(mergedSourceROM, patch);
  } catch {
    return null;
  }
}

module.exports = { apply, decode, XdeltaError };
