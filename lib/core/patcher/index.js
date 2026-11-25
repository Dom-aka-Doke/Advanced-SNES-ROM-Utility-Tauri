'use strict';

const fs = require('fs');
const path = require('path');
const IPS = require('./ips');
const UPS = require('./ups');
const BPS = require('./bps');
const BDF = require('./bdf');
const XDELTA = require('./xdelta');

const PATCH_EXTENSIONS = ['.ips', '.ups', '.bps', '.bdf', '.xdelta'];

/**
 * Applies a patch file to the loaded ROM (like ButtonPatch_Click in FormMain.cs).
 * The SMC header is merged before patching and removed afterwards (ROM gets re-initialized).
 * @param {import('../snesrom').SNESROM} rom
 * @param {string} patchPath
 * @returns {{ok: boolean, message?: string}}
 */
function applyPatchFile(rom, patchPath) {
  const ext = path.extname(patchPath).toLowerCase();
  const patch = new Uint8Array(fs.readFileSync(patchPath));
  const merged = rom.getMergedROM();
  let patched = null;
  let message;

  switch (ext) {
    case '.ips': patched = IPS.apply(merged, patch); break;
    case '.ups': patched = UPS.apply(merged, rom.CRC32Hash, patch); break;
    case '.bps': patched = BPS.apply(merged, rom.CRC32Hash, patch); break;
    case '.bdf': patched = BDF.apply(merged, patch); break;
    case '.xdelta':
      try {
        patched = XDELTA.decode(merged, patch);
      } catch (err) {
        patched = null;
        if (err instanceof XDELTA.XdeltaError) message = err.message;
      }
      break;
    default:
      return { ok: false, message: 'Unsupported patch format.' };
  }

  if (!patched) {
    return { ok: false, message };
  }

  rom.SourceROM = patched;
  rom.UIntSMCHeader = 0;
  rom.SourceROMSMCHeader = null;
  rom.initialize(['all']);

  return { ok: true };
}

module.exports = { applyPatchFile, PATCH_EXTENSIONS, IPS, UPS, BPS, BDF, XDELTA };
