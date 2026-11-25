'use strict';

// Tests of the browser replacements (lib/shims) and the core bundle: npm test

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const shimCrypto = require('../lib/shims/crypto');
const shimPath = require('../lib/shims/path');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(err);
    process.exitCode = 1;
  }
}

console.log('Browser shims');

test('MD5 / SHA-1 / SHA-256 match Node.js', () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 1000, 100000, 1 << 20]) {
    const data = crypto.randomBytes(len);
    for (const alg of ['md5', 'sha1', 'sha256']) {
      const expected = crypto.createHash(alg).update(data).digest('hex');
      assert.strictEqual(shimCrypto.createHash(alg).update(new Uint8Array(data)).digest('hex'), expected, `${alg} ${len}`);
    }
  }
});

test('path works with Windows and POSIX paths', () => {
  assert.strictEqual(shimPath.dirname('C:\\ROMs\\game.sfc'), 'C:\\ROMs');
  assert.strictEqual(shimPath.dirname('C:\\game.sfc'), 'C:\\');
  assert.strictEqual(shimPath.dirname('/home/user/game.sfc'), '/home/user');
  assert.strictEqual(shimPath.basename('C:\\ROMs\\game.sfc', '.sfc'), 'game');
  assert.strictEqual(shimPath.extname('/roms/Game.SMC'), '.SMC');
  assert.strictEqual(shimPath.join('C:\\ROMs', 'game_[1].bin'), 'C:\\ROMs\\game_[1].bin');
  assert.strictEqual(shimPath.join('/roms/', 'game.bin'), '/roms/game.bin');
});

test('core bundle loads a ROM from the in-memory file table', () => {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'bundle-core.js')]);
  global.window = {};
  require('../web/js/core.bundle.js');
  const R = global.window.ASRU.require;
  const vfs = R('shims/fs').__vfs;
  const { SNESROM } = R('core/snesrom');
  const C = R('core/converter');

  // 1 Mbit LoROM with header
  const rom = new Uint8Array(crypto.randomBytes(0x20000));
  const off = 0x7FB0;
  rom.fill(0, off, off + 0x50);
  rom.set(Buffer.from('BUNDLE TEST'.padEnd(21, ' ')), off + 0x10);
  rom[off + 0x25] = 0x20;
  rom[off + 0x27] = 0x07;
  rom.set([0xFF, 0xFF, 0x00, 0x00], off + 0x2C);
  rom[off + 0x4D] = 0x80;

  const file = 'C:\\ROMs\\bundle.sfc';
  vfs.put(file, rom);
  const loaded = new SNESROM(file);
  vfs.drop(file);

  assert.strictEqual(loaded.StringTitle.trim(), 'BUNDLE TEST');
  assert.strictEqual(loaded.ROMFolder, 'C:\\ROMs');
  assert.strictEqual(loaded.MD5Hash, crypto.createHash('md5').update(rom).digest('hex'));

  // Files written by the core are collected for the app
  C.split(loaded, 1);
  const writes = vfs.takeWrites();
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].path, 'C:\\ROMs\\bundle_[0]_[split].bin');
});

test('frontend files exist', () => {
  for (const f of ['index.html', 'renderer.js', 'js/app.js', 'js/platform.js', 'js/modal.js', 'js/bridge-child.js',
    'heatmap.html', 'about.html', 'manual.html']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'web', f)), f);
  }
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
