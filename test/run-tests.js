'use strict';

// Self-contained tests for the ported core logic: npm test

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const { SNESROM } = require('../lib/core/snesrom');
const F = require('../lib/core/functions');
const C = require('../lib/core/converter');
const { applyPatchFile } = require('../lib/core/patcher');
const { crc32Hex } = require('../lib/core/helper/crc32');
const sjis = require('../lib/core/helper/shiftjis');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asru-test-'));
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n${err.stack}`);
    process.exitCode = 1;
  }
}

/** Creates a synthetic ROM with a valid internal header */
function makeROM({ size, offset, mapMode, title, country = 0x01, sram = 0x00, type = 0x00, sizeCode }) {
  const rom = new Uint8Array(crypto.randomBytes(size));
  rom.fill(0, offset, offset + 0x50);
  const t = Buffer.from(title.padEnd(21, ' '), 'ascii');
  rom.set(t, offset + 0x10);
  rom[offset + 0x25] = mapMode;
  rom[offset + 0x26] = type;
  rom[offset + 0x27] = sizeCode;
  rom[offset + 0x28] = sram;
  rom[offset + 0x29] = country;
  rom[offset + 0x2A] = 0x01;
  rom.set([0xFF, 0xFF, 0x00, 0x00], offset + 0x2C);
  rom[offset + 0x4C] = 0x00;
  rom[offset + 0x4D] = 0x80;
  rom[0x8000] = 0x78; // sei
  return rom;
}

function expectedChecksum(rom, offset) {
  const copy = new Uint8Array(rom);
  copy.set([0xFF, 0xFF, 0x00, 0x00], offset + 0x2C);
  let sum = 0;
  for (const b of copy) sum = (sum + b) & 0xFFFF;
  return sum.toString(16).toUpperCase().padStart(4, '0');
}

const loROMData = makeROM({ size: 1 << 20, offset: 0x7FB0, mapMode: 0x20, title: 'TEST LOROM', country: 0x02, sram: 0x03, type: 0x02, sizeCode: 0x0A });
loROMData.set(Buffer.from('AD3F21291000D0', 'hex'), 0x1234); // PAL region check
const loROMPath = path.join(tmp, 'lorom.sfc');
fs.writeFileSync(loROMPath, loROMData);

const hiROMData = makeROM({ size: 2 << 20, offset: 0xFFB0, mapMode: 0x31, title: 'TEST HIROM', sizeCode: 0x0B });
const hiROMPath = path.join(tmp, 'hirom.sfc');
fs.writeFileSync(hiROMPath, hiROMData);

const headeredPath = path.join(tmp, 'lorom.smc');
fs.writeFileSync(headeredPath, Buffer.concat([Buffer.alloc(512), Buffer.from(loROMData)]));

console.log('Advanced SNES ROM Utility – core tests');

test('LoROM header detection', () => {
  const rom = new SNESROM(loROMPath);
  assert.strictEqual(rom.StringTitle.trim(), 'TEST LOROM');
  assert.strictEqual(rom.StringMapMode, 'LoROM');
  assert.strictEqual(rom.StringROMType, 'ROM+RAM+Battery');
  assert.strictEqual(rom.StringROMSize, '8 Mbit');
  assert.strictEqual(rom.IntCalcFileSize, 8);
  assert.strictEqual(rom.StringRegion, 'PAL');
  assert.strictEqual(rom.StringCompany, 'Nintendo');
  assert.strictEqual(rom.StringRAMSize, 'Yes (8 kByte)');
  assert.strictEqual(rom.StringSMCHeader, 'No');
});

test('HiROM header detection', () => {
  const rom = new SNESROM(hiROMPath);
  assert.strictEqual(rom.StringMapMode, 'HiROM');
  assert.strictEqual(rom.StringROMSpeed, 'FastROM (120 ns)');
  assert.strictEqual(rom.StringCountry, 'USA');
});

test('checksum calculation and fixing', () => {
  const rom = new SNESROM(loROMPath);
  assert.strictEqual(rom.calcChecksumHex, expectedChecksum(loROMData, 0x7FB0));
  F.fixChecksum(rom);
  assert.strictEqual(rom.checksumHex, rom.calcChecksumHex);
  assert.strictEqual(rom.invChecksumHex, (0xFFFF ^ parseInt(rom.checksumHex, 16)).toString(16).toUpperCase().padStart(4, '0'));
});

test('hashes incl. SMC header', () => {
  const rom = new SNESROM(headeredPath);
  const file = fs.readFileSync(headeredPath);
  assert.strictEqual(rom.StringSMCHeader, 'Yes');
  assert.strictEqual(rom.CRC32Hash, crc32Hex(file));
  assert.strictEqual(rom.MD5Hash, crypto.createHash('md5').update(file).digest('hex'));
  assert.strictEqual(rom.SHA256Hash, crypto.createHash('sha256').update(file).digest('hex'));
});

test('add / remove header', () => {
  const rom = new SNESROM(loROMPath);
  F.addHeader(rom);
  assert.strictEqual(rom.StringSMCHeader, 'Yes');
  assert.strictEqual(rom.getSaveData().length, loROMData.length + 512);
  F.removeHeader(rom);
  assert.strictEqual(rom.StringSMCHeader, 'No');
});

test('edit title, version, country, game code', () => {
  const rom = new SNESROM(loROMPath);
  rom.setTitle('NEW NAME', rom.ByteArrayTitle.length);
  assert.strictEqual(rom.StringTitle.trim(), 'NEW NAME');
  rom.setVersion(3);
  assert.strictEqual(rom.StringVersion, '1.3');
  rom.setCountryRegion(9);
  assert.strictEqual(rom.StringCountry, 'Germany/Austria/Switzerland');
});

test('Shift-JIS round trip', () => {
  const text = 'ｴｰｽｦﾈﾗｴ!';
  assert.strictEqual(sjis.decode(sjis.encode(text)), text);
});

test('remove region checks', () => {
  const rom = new SNESROM(loROMPath);
  assert.ok(F.removeRegionChecks(rom, false));
  assert.ok(F.removeRegionChecks(rom));
  assert.strictEqual(Buffer.from(rom.SourceROM.subarray(0x1234, 0x123B)).toString('hex').toUpperCase(), 'AD3F2129100080');
  assert.ok(!F.removeRegionChecks(rom, false));
});

test('interleave / deinterleave round trip', () => {
  const rom = new SNESROM(hiROMPath);
  const original = Buffer.from(rom.SourceROM);
  C.interleave(rom, () => 'standard');
  assert.ok(rom.IsInterleaved);
  C.deinterleave(rom, () => 'standard');
  assert.ok(Buffer.from(rom.SourceROM).equals(original));
});

test('expand and fix internal ROM size', () => {
  const rom = new SNESROM(loROMPath);
  C.expand(rom, 16, false);
  assert.strictEqual(rom.IntCalcFileSize, 16);
  assert.ok(F.needsInternalROMSizeFix(rom));
  F.fixInternalROMSize(rom);
  assert.strictEqual(rom.StringROMSize, '16 Mbit');
});

test('convert HiROM -> LoROM -> HiROM', () => {
  const rom = new SNESROM(hiROMPath);
  C.convertMapMode(rom);
  assert.strictEqual(rom.StringMapMode, 'LoROM');
  C.convertMapMode(rom);
  assert.strictEqual(rom.StringMapMode, 'HiROM');
});

test('IPS patch (incl. RLE)', () => {
  const ips = Buffer.concat([
    Buffer.from('PATCH'),
    Buffer.from([0x00, 0x00, 0x10, 0x00, 0x03, 0xAA, 0xBB, 0xCC]),
    Buffer.from([0x00, 0x00, 0x20, 0x00, 0x00, 0x00, 0x08, 0x55]),
    Buffer.from('EOF'),
  ]);
  const patchPath = path.join(tmp, 'test.ips');
  fs.writeFileSync(patchPath, ips);

  const rom = new SNESROM(loROMPath);
  assert.ok(applyPatchFile(rom, patchPath).ok);
  assert.strictEqual(Buffer.from(rom.SourceROM.subarray(0x10, 0x13)).toString('hex'), 'aabbcc');
  assert.ok(rom.SourceROM.subarray(0x20, 0x28).every((b) => b === 0x55));
});

test('SRAM size: normal ROM uses $FFD8', () => {
  const rom = new SNESROM(loROMPath);
  const info = rom.getSRAMSizeInfo();
  assert.ok(info.editable);
  assert.strictEqual(info.target, 'sram');
  assert.ok(rom.setSRAMSize(5));
  assert.strictEqual(rom.ByteSRAMSize, 5);
  assert.strictEqual(rom.StringRAMSize, 'Yes (32 kByte)');
  assert.strictEqual(rom.SourceROM[0x7FB0 + 0x28], 5);
  assert.ok(rom.setSRAMSize(0));
  assert.strictEqual(rom.StringRAMSize, 'No');
});

test('SRAM size: Super FX without extended header (Star Fox) is locked', () => {
  const data = makeROM({ size: 1 << 20, offset: 0x7FB0, mapMode: 0x20, title: 'STAR FOX', type: 0x13, sizeCode: 0x0A });
  const p = path.join(tmp, 'starfox.sfc');
  fs.writeFileSync(p, data);
  const rom = new SNESROM(p);
  assert.ok(rom.isSuperFX);
  assert.ok(!rom.IsNewHeader);
  assert.ok(!rom.getSRAMSizeInfo().editable);
  assert.ok(!rom.setSRAMSize(5));
  assert.ok(Buffer.from(rom.SourceROM).equals(Buffer.from(data)));
});

test('SRAM size: Super FX with extended header uses $FFBD', () => {
  const data = makeROM({ size: 2 << 20, offset: 0x7FB0, mapMode: 0x20, title: 'GSU2 TEST', type: 0x15, sizeCode: 0x0B });
  data[0x7FB0 + 0x2A] = 0x33;                   // extended header present
  data.set(Buffer.from('01'), 0x7FB0);          // maker code
  const p = path.join(tmp, 'gsu2.sfc');
  fs.writeFileSync(p, data);
  const rom = new SNESROM(p);
  const info = rom.getSRAMSizeInfo();
  assert.ok(info.editable);
  assert.strictEqual(info.target, 'exram');
  assert.ok(rom.setSRAMSize(5));
  assert.strictEqual(rom.SourceROM[0x7FB0 + 0x0D], 5);
  assert.strictEqual(rom.SourceROM[0x7FB0 + 0x28], 0);
  assert.strictEqual(rom.StringRAMSize, 'Yes (32 kByte)');
});

test('company code transformation round trip', () => {
  const CC = require('../lib/core/helper/companycode');
  const companies = require('../lib/core/lists/company');
  for (const key of Object.keys(companies)) {
    const code = parseInt(key, 16);
    const bytes = CC.encodeNew(code);
    assert.ok(bytes, key);
    assert.strictEqual(CC.decodeNew(bytes[0], bytes[1]), code);
    const byte = CC.encodeOld(code);
    if (byte !== null) assert.strictEqual(CC.decodeOld(byte), code);
  }
  assert.strictEqual(CC.encodeOld(0x016C), 0xA4);                 // Konami
  assert.strictEqual(Buffer.from(CC.encodeNew(0x016C)).toString(), 'A4');
  assert.strictEqual(CC.encodeOld(3 * 36 + 3), null);              // 0x33 is reserved
  assert.strictEqual(CC.encodeOld(16 * 36), null);                 // "G0" does not fit into one byte
});

test('set company: old header writes $FFDA', () => {
  const rom = new SNESROM(loROMPath);
  assert.ok(!rom.hasMakerCode);
  assert.ok(rom.setCompany(0x016C));
  assert.strictEqual(rom.StringCompany, 'Konami');
  assert.strictEqual(rom.SourceROM[0x7FB0 + 0x2A], 0xA4);
  assert.ok(!rom.setCompany(16 * 36));
  assert.ok(rom.getCompanyOptions().every((o) => /^[0-9A-F]{2}$/.test(o.notation)));
});

test('set company: extended header writes maker code at $FFB0', () => {
  const data = makeROM({ size: 1 << 20, offset: 0x7FB0, mapMode: 0x20, title: 'NEW HEADER', sizeCode: 0x0A });
  data[0x7FB0 + 0x2A] = 0x33;
  data.set(Buffer.from('01'), 0x7FB0);
  const p = path.join(tmp, 'newheader.sfc');
  fs.writeFileSync(p, data);
  const rom = new SNESROM(p);
  assert.ok(rom.hasMakerCode);
  assert.strictEqual(rom.StringCompany, 'Nintendo');
  assert.ok(rom.setCompany(0x018E));
  assert.strictEqual(rom.StringCompany, 'Bandai');
  assert.strictEqual(Buffer.from(rom.SourceROM.subarray(0x7FB0, 0x7FB2)).toString(), 'B2');
  assert.strictEqual(rom.SourceROM[0x7FB0 + 0x2A], 0x33);
});

test('title: double byte characters are never cut in half', () => {
  const rom = new SNESROM(loROMPath);
  const max = rom.ByteArrayTitle.length; // 21
  rom.setTitle('ABCDEFGHIJKLMNOPQRSTテ', max); // 20 + 2 bytes -> テ does not fit
  assert.strictEqual(rom.StringTitle, 'ABCDEFGHIJKLMNOPQRST ');
  assert.strictEqual(rom.ByteArrayTitle[max - 1], 0x20);
  rom.setTitle('ABCDEFGHIJKLMNOPQRSテ', max);  // 19 + 2 bytes = 21 -> fits exactly
  assert.strictEqual(rom.StringTitle, 'ABCDEFGHIJKLMNOPQRSテ');
  rom.setTitle('ﾃｽﾄ', max);                     // half width katakana: 1 byte each
  assert.strictEqual(rom.StringTitle.trim(), 'ﾃｽﾄ');
  assert.strictEqual(sjis.byteLength('ﾃｽﾄテ'), 5);
});

test('game code: only A-Z and 0-9', () => {
  const data = makeROM({ size: 1 << 20, offset: 0x7FB0, mapMode: 0x20, title: 'CODE TEST', sizeCode: 0x0A });
  data[0x7FB0 + 0x2A] = 0x33;
  data.set(Buffer.from('01AAAA'), 0x7FB0);
  const p = path.join(tmp, 'gamecode.sfc');
  fs.writeFileSync(p, data);
  const rom = new SNESROM(p);
  rom.setGameCode('a-ゲ7x');
  assert.strictEqual(rom.StringGameCode, 'A7X ');
});

test('BPS: metadata of exactly 128 bytes is skipped', () => {
  const BPS = require('../lib/core/patcher/bps');
  const vwi = (n) => {
    const o = [];
    for (;;) {
      const x = n & 0x7F;
      n >>= 7;
      if (n === 0) { o.push(0x80 | x); break; }
      o.push(x);
      n--;
    }
    return Buffer.from(o);
  };
  const crcLE = (b) => Buffer.from(crc32Hex(b).match(/../g).reverse().join(''), 'hex');
  const src = Buffer.alloc(1000, 1);
  const dst = Buffer.alloc(1000, 2);
  for (const ml of [0, 127, 128, 300]) {
    let p = Buffer.concat([Buffer.from('BPS1'), vwi(1000), vwi(1000), vwi(ml), Buffer.alloc(ml, 0x41),
      vwi(((1000 - 1) << 2) | 1), dst, crcLE(src), crcLE(dst)]);
    p = Buffer.concat([p, crcLE(p)]);
    const out = BPS.apply(new Uint8Array(src), crc32Hex(src), new Uint8Array(p));
    assert.ok(out && Buffer.from(out).equals(dst), `metadata ${ml}`);
  }
});

test('UPS: patch and revert are verified', () => {
  const UPS = require('../lib/core/patcher/ups');
  const vwi = (n) => {
    const o = [];
    for (;;) {
      const x = n & 0x7F;
      n >>= 7;
      if (n === 0) { o.push(0x80 | x); break; }
      o.push(x);
      n--;
    }
    return Buffer.from(o);
  };
  const crcLE = (b) => Buffer.from(crc32Hex(b).match(/../g).reverse().join(''), 'hex');
  const src = Buffer.alloc(100, 1);
  const dst = Buffer.from(src);
  dst[10] = 5;
  let p = Buffer.concat([Buffer.from('UPS1'), vwi(100), vwi(100), vwi(10), Buffer.from([1 ^ 5, 0]), crcLE(src), crcLE(dst)]);
  p = Buffer.concat([p, crcLE(p)]);
  const forward = UPS.apply(new Uint8Array(src), crc32Hex(src), new Uint8Array(p));
  assert.ok(forward && Buffer.from(forward).equals(dst));
  const revert = UPS.apply(new Uint8Array(dst), crc32Hex(dst), new Uint8Array(p));
  assert.ok(revert && Buffer.from(revert).equals(src));
  // Corrupt patch data with valid checksums of the patch itself -> result must be rejected
  let bad = Buffer.concat([Buffer.from('UPS1'), vwi(100), vwi(100), vwi(10), Buffer.from([0x77, 0]), crcLE(src), crcLE(dst)]);
  bad = Buffer.concat([bad, crcLE(bad)]);
  assert.strictEqual(UPS.apply(new Uint8Array(dst), crc32Hex(dst), new Uint8Array(bad)), null);
});

test('overdump: mirrored and padded data, no false positives', () => {
  const Analysis = require('../lib/core/analysis');
  const MB = Analysis.MBIT;
  const base = Buffer.from(loROMData);
  const check = (name, buf) => {
    const p = path.join(tmp, `${name}.sfc`);
    fs.writeFileSync(p, buf);
    return new SNESROM(p);
  };

  // 4 Mbit game dumped as 8 Mbit
  let rom = check('od1', Buffer.concat([base.subarray(0, 4 * MB), base.subarray(0, 4 * MB)]));
  let info = Analysis.detectOverdump(rom);
  assert.strictEqual(info.type, 'mirror');
  assert.strictEqual(info.realSize, 4 * MB);

  // 12 Mbit game dumped as 16 Mbit (last 4 Mbit mirrored)
  const twelve = Buffer.concat([base, crypto.randomBytes(4 * MB)]);
  rom = check('od2', Buffer.concat([twelve, twelve.subarray(8 * MB, 12 * MB)]));
  assert.strictEqual(Analysis.detectOverdump(rom).realSize, 12 * MB);

  // 8 Mbit + 8 Mbit 0xFF padding -> back to the internal size
  rom = check('od3', Buffer.concat([base, Buffer.alloc(8 * MB, 0xFF)]));
  info = Analysis.removeOverdump(rom);
  assert.strictEqual(info.type, 'padding');
  assert.strictEqual(rom.SourceROM.length, 8 * MB);

  // Real 12 Mbit ROM and filled area inside the internal size are no overdumps
  assert.ok(!Analysis.detectOverdump(check('od4', twelve)).overdump);
  assert.ok(!Analysis.detectOverdump(check('od5', Buffer.concat([base.subarray(0, 6 * MB), Buffer.alloc(2 * MB, 0xFF)]))).overdump);
  assert.ok(!Analysis.detectOverdump(new SNESROM(loROMPath)).overdump);
});

test('bank analysis finds identical and empty banks', () => {
  const Analysis = require('../lib/core/analysis');
  const MB = Analysis.MBIT;
  const buf = Buffer.concat([Buffer.from(loROMData).subarray(0, 4 * MB), Buffer.from(loROMData).subarray(0, 2 * MB), Buffer.alloc(2 * MB, 0xFF)]);
  const p = path.join(tmp, 'banks.sfc');
  fs.writeFileSync(p, buf);
  const rom = new SNESROM(p);
  const lo = Analysis.analyzeBanks(rom);
  assert.strictEqual(lo.bankSize, 0x8000);
  assert.strictEqual(lo.summary.banks, 32);
  assert.strictEqual(lo.summary.duplicates, 16);
  assert.strictEqual(lo.summary.copies, 8);
  assert.strictEqual(lo.summary.unique, 8);
  assert.strictEqual(lo.summary.empty, 8);
  assert.strictEqual(lo.banks[16].duplicateOf, 0);
  assert.strictEqual(lo.banks[0].snes, '$00:8000');
  assert.ok(lo.banks[0].header);
  const hi = Analysis.analyzeBanks(new SNESROM(hiROMPath));
  assert.strictEqual(hi.bankSize, 0x10000);
  assert.strictEqual(hi.banks[1].snes, '$C1:0000');
});

test('mirroring follows the SNES address decoding', () => {
  const MB = 0x20000;
  // Every Mbit gets its own id (1, 2, 3, ...) so the layout can be compared
  const make = (mbit) => {
    const b = new Uint8Array(mbit * MB);
    for (let i = 0; i < mbit; i++) b.fill(i + 1, i * MB, (i + 1) * MB);
    return b;
  };
  const layout = (img) => Array.from({ length: img.length / MB }, (_, i) => img[i * MB]).join(' ');
  const seq = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i).join(' ');

  // Expected layouts written down by hand (header size / real data size in Mbit)
  const expected = [
    [16, 12, `${seq(1, 12)} ${seq(9, 12)}`],                                 // 8 + 4 -> 8 + 4 + 4
    [32, 20, `${seq(1, 20)} ${seq(17, 20)} ${seq(17, 20)} ${seq(17, 20)}`],  // 16 + 4 x 4
    [64, 48, `${seq(1, 48)} ${seq(33, 48)}`],                                // 32 + 16 + 16
    [4, 3, '1 2 3 3'],                                                       // 2 + 1 + 1
    [16, 14, `${seq(1, 14)} 13 14`],                                         // 8 + (4 + 2 + 2)
    [8, 7, '1 2 3 4 5 6 7 7'],                                               // 4 + (2 + 1 + 1)
    [32, 22, `${seq(1, 22)} 21 22 ${seq(17, 22)} 21 22`],                    // 16 + (4 + 2 + 2) x 2
    [16, 8, `${seq(1, 8)} ${seq(1, 8)}`],                                    // power of two repeats
    [32, 8, [1, 2, 3, 4].map(() => seq(1, 8)).join(' ')],
  ];

  for (const [target, data, exp] of expected) {
    assert.strictEqual(layout(C.mirror(make(data), target, data)), exp, `${data} Mbit in ${target} Mbit`);
  }
});

test('checksum and expand use the real data size', () => {
  const MB = 0x20000;

  // 8 Mbit file, header says 16 Mbit: SNES sees the 8 Mbit twice -> checksum = 2 x sum
  const h = Buffer.from(loROMData);
  h[0x7FB0 + 0x27] = 0x0B;
  const p1 = path.join(tmp, 'hdr16.sfc');
  fs.writeFileSync(p1, h);
  const rom = new SNESROM(p1);
  const copy = Buffer.from(rom.SourceROM);
  copy.set([0xFF, 0xFF, 0x00, 0x00], 0x7FB0 + 0x2C);
  let sum = 0;
  for (const b of copy) sum = (sum + b) & 0xFFFF;
  assert.strictEqual(rom.calcChecksumHex, ((sum * 2) & 0xFFFF).toString(16).toUpperCase().padStart(4, '0'));

  // 12 Mbit file, header says 8 Mbit: expanding with mirroring must keep all data
  const twelve = Buffer.concat([Buffer.from(loROMData), Buffer.alloc(4 * MB, 0x77)]);
  const p2 = path.join(tmp, 'hdr8.sfc');
  fs.writeFileSync(p2, twelve);
  const rom2 = new SNESROM(p2);
  C.expand(rom2, 16, true);
  assert.ok(rom2.SourceROM.subarray(8 * MB, 12 * MB).every((b) => b === 0x77));
  assert.ok(rom2.SourceROM.subarray(12 * MB, 16 * MB).every((b) => b === 0x77));
  assert.ok(Buffer.from(rom2.SourceROM.subarray(0, 8 * MB)).equals(Buffer.from(loROMData)));
});

test('expand: fill with 0x00, 0xFF or mirrored data', () => {
  const MB = 0x20000;
  for (const [fill, check] of [
    ['00', (rom) => rom.SourceROM.subarray(8 * MB).every((b) => b === 0x00)],
    ['FF', (rom) => rom.SourceROM.subarray(8 * MB).every((b) => b === 0xFF)],
    ['mirror', (rom) => Buffer.from(rom.SourceROM.subarray(8 * MB)).equals(Buffer.from(loROMData))],
  ]) {
    const rom = new SNESROM(loROMPath);
    C.expand(rom, 16, fill);
    assert.strictEqual(rom.SourceROM.length, 16 * MB);
    assert.ok(Buffer.from(rom.SourceROM.subarray(0, 8 * MB)).equals(Buffer.from(loROMData)), fill);
    assert.ok(check(rom), `fill ${fill}`);
  }
});

test('expand to ExLoROM / ExHiROM keeps banks $00-$3F reachable', () => {
  const MB = 0x20000;
  const EX = 0x400000;

  // LoROM 8 Mbit -> 48 Mbit: $00-$3F:8000 = ROM $400000+, one to one copy; rest is free space
  let rom = new SNESROM(loROMPath);
  C.expand(rom, 48, 'FF');
  assert.ok(Buffer.from(rom.SourceROM.subarray(EX, EX + 8 * MB)).equals(Buffer.from(loROMData)));
  assert.ok(rom.SourceROM.subarray(8 * MB, EX).every((b) => b === 0xFF));
  assert.ok(rom.SourceROM.subarray(EX + 8 * MB).every((b) => b === 0xFF));

  // HiROM 16 Mbit -> 64 Mbit: upper halves of the 64K banks are copied, lower halves stay free
  rom = new SNESROM(hiROMPath);
  C.expand(rom, 64, '00');
  assert.strictEqual(rom.StringMapMode, 'ExHiROM');
  for (const bank of [0, 1, 0x1F]) {
    const src = bank * 0x10000 + 0x8000;
    // compared with the lower area, which already contains the new map mode in the header
    assert.ok(Buffer.from(rom.SourceROM.subarray(EX + src, EX + src + 0x8000)).equals(Buffer.from(rom.SourceROM.subarray(src, src + 0x8000))), `bank ${bank}`);
    if (bank > 0) assert.ok(Buffer.from(rom.SourceROM.subarray(src, src + 0x8000)).equals(Buffer.from(hiROMData.subarray(src, src + 0x8000))));
    assert.ok(rom.SourceROM.subarray(EX + bank * 0x10000, EX + bank * 0x10000 + 0x8000).every((b) => b === 0), `free ${bank}`);
  }
  assert.ok(rom.SourceROM.subarray(EX + 0x200000).every((b) => b === 0));

  // Enhancement chips with own mapping do not get ExROM sizes
  const sa1 = makeROM({ size: 1 << 20, offset: 0x7FB0, mapMode: 0x23, title: 'SA1 TEST', type: 0x35, sizeCode: 0x0A });
  const pSA1 = path.join(tmp, 'sa1.sfc');
  fs.writeFileSync(pSA1, sa1);
  assert.ok(!C.canExpandToExROM(new SNESROM(pSA1)));
  assert.ok(C.canExpandToExROM(new SNESROM(loROMPath)));

  // ...but can still be expanded beyond 32 Mbit as free space: data and header stay untouched
  const romSA1 = new SNESROM(pSA1);
  C.expand(romSA1, 64, '00');
  assert.strictEqual(romSA1.SourceROM.length, 8 << 20);
  assert.ok(F.bytesEqual(romSA1.SourceROM.subarray(0, sa1.length), sa1));
  assert.ok(romSA1.SourceROM.subarray(sa1.length).every((b) => b === 0));
});

test('small homebrew / test ROMs (32 / 64 kByte) can be loaded', () => {
  const Analysis = require('../lib/core/analysis');
  // 32 kByte LoROM, header size 0x05 (256 Kbit)
  const lo = makeROM({ size: 0x8000, offset: 0x7FB0, mapMode: 0x20, title: 'TINY LOROM', sizeCode: 0x05 });
  const pLo = path.join(tmp, 'tiny_lo.sfc');
  fs.writeFileSync(pLo, lo);
  const romLo = new SNESROM(pLo);
  assert.strictEqual(romLo.StringMapMode.startsWith('LoROM'), true);
  assert.strictEqual(romLo.IntROMSize, 0.25);
  assert.strictEqual(romLo.StringROMSize, '256 Kbit');
  assert.strictEqual(romLo.IntCalcFileSize, 0.25);
  assert.strictEqual(F.formatMByte(romLo.IntCalcFileSize), '32 kByte');
  assert.strictEqual(F.bytesToHex(romLo.ByteArrayCalcChecksum), expectedChecksum(lo, 0x7FB0));
  assert.ok(!F.needsInternalROMSizeFix(romLo));

  // 64 kByte HiROM with a too large internal size (1 Mbit) -> mirrored checksum, fixable to 0x06
  const hi = makeROM({ size: 0x10000, offset: 0xFFB0, mapMode: 0x21, title: 'TINY HIROM', sizeCode: 0x07 });
  const pHi = path.join(tmp, 'tiny_hi.sfc');
  fs.writeFileSync(pHi, hi);
  const romHi = new SNESROM(pHi);
  assert.strictEqual(romHi.StringMapMode.startsWith('HiROM'), true);
  assert.strictEqual(romHi.IntROMSize, 1);
  assert.strictEqual(romHi.IntCalcFileSize, 0.5);
  assert.ok(F.needsInternalROMSizeFix(romHi));
  F.fixInternalROMSize(romHi);
  assert.strictEqual(romHi.SourceROM[0xFFD7], 0x06);
  assert.strictEqual(romHi.StringROMSize, '512 Kbit');

  // Smaller than 32 kByte is still refused
  const pTooSmall = path.join(tmp, 'too_small.sfc');
  fs.writeFileSync(pTooSmall, new Uint8Array(0x4000));
  assert.throws(() => new SNESROM(pTooSmall), /32 kByte/);

  // 32 kByte game dumped as 128 kByte (4 copies) -> mirror overdump
  const od = new Uint8Array(0x20000);
  for (let i = 0; i < 4; i++) od.set(lo, i * 0x8000);
  const pOd = path.join(tmp, 'tiny_od.sfc');
  fs.writeFileSync(pOd, od);
  const romOd = new SNESROM(pOd);
  const info = Analysis.detectOverdump(romOd);
  assert.strictEqual(info.type, 'mirror');
  assert.strictEqual(info.realSize, 0x8000);

  // Expanding 32 kByte to 512 Kbit / 1 Mbit
  C.expand(romLo, 0.5, '00');
  assert.strictEqual(romLo.SourceROM.length, 0x10000);
  C.expand(romLo, 1, 'mirror');
  assert.strictEqual(romLo.SourceROM.length, 0x20000);
  assert.ok(F.bytesEqual(romLo.SourceROM.subarray(0x10000, 0x18000), lo));
});

test('split / swapbin write files', () => {
  const rom = new SNESROM(hiROMPath);
  const parts = C.split(rom, 8);
  assert.strictEqual(parts.length, 2);
  assert.ok(parts.every((p) => fs.statSync(p).size === 1048576));
  const swapped = C.swapBin(rom);
  assert.strictEqual(swapped.length, 2);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
