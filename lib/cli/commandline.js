'use strict';

// Port of Commandline/SNESROMCommandline.cs

const fs = require('fs');
const path = require('path');
const { SNESROM } = require('../core/snesrom');
const F = require('../core/functions');
const C = require('../core/converter');
const { applyPatchFile } = require('../core/patcher');
const { HeaderOffset, Speed } = require('../core/enums');
const CC = require('../core/helper/companycode');
const Analysis = require('../core/analysis');
const version = require('../version');

const CLI_PARAMETERS = [
  '-path', '-recursive', '-overwrite', '-header', '-fixchecksum', '-fixromsize',
  '-removeregion', '-removesram', '-removeslowrom', '-deinterleave', '-interleave',
  '-patch', '-sram', '-company', '-removeoverdump', '-log', '-version', '-help',
];

const CLI_FILE_EXTENSIONS = ['.smc', '.sfc', '.swc', '.fig'];

const HELP_TEXT =
  'Usage:\n' +
  '\tAdvanced_SNES_ROM_Utility [options]\n' +
  '\n' +
  '\tOptions:\n' +
  '\t\t-path <FILEPATH, FOLDER>\tPath or folder of the ROM file(s)\n' +
  '\t\t-recursive\t\t\tInclude files from subdirectories\n' +
  '\t\t-overwrite\t\t\tOverwrite files on saving (else an extension will be used)\n' +
  '\t\t-header <add, remove>\t\tAdds or removes a header\n' +
  '\t\t-fixchecksum\t\t\tFixes a broken checksum\n' +
  '\t\t-fixromsize\t\t\tFixes a wrong internal ROM size\n' +
  '\t\t-removeregion\t\t\tRemoves existing region checks\n' +
  '\t\t-removesram\t\t\tRemoves existing SRAM checks\n' +
  '\t\t-removeslowrom\t\t\tRemoves existing SlowROM checks\n' +
  '\t\t-deinterleave\t\t\tDeinterleave, if ROM is in interleaved format\n' +
  '\t\t-interleave\t\t\tInterleave, if ROM is in deinterleaved format\n' +
  '\t\t-patch <FILEPATH>\t\tPatch ROM with a specific patch\n' +
  '\t\t-removeoverdump\t\t\tRemoves mirrored or padded data of an overdumped ROM\n' +
  '\t\t-company <CODE>\t\tSets the company by its 2 character code (f.e. 01 = Nintendo, A4 = Konami)\n' +
  '\t\t-sram <0-7>\t\t\tSets (S)RAM size: 0 = none, n = 2^n kByte (1 = 2 kByte ... 7 = 128 kByte)\n' +
  '\t\t-log\t\t\t\tWrite output to a logfile\n' +
  '\t\t-version\t\t\tShow version information\n' +
  '\t\t-help\t\t\t\tShow help and usage information\n';

const pad = (n, l = 2) => String(n).padStart(l, '0');

function timestamp(d = new Date()) {
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(Math.floor(d.getMilliseconds() / 10))}`;
}

function fileTimestamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function listFiles(dir, recursive) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) result.push(...listFiles(full, true));
    } else if (CLI_FILE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      result.push(full);
    }
  }
  return result;
}

/**
 * Runs the command line interface.
 * @param {string[]} args arguments (without executable)
 * @param {object} options
 * @param {function(string):void} [options.print] output function
 * @param {function(string):string} [options.chooseCopier] returns 'gd' | 'ufo' | 'standard' | 'cancel'
 * @param {string} [options.logDir] directory for the log file
 * @returns {number} exit code
 */
function run(args, options = {}) {
  const print = options.print || ((text) => process.stdout.write(text + '\n'));
  const chooseCopier = options.chooseCopier || (() => 'standard');

  const inputParameters = args.filter((a) => a.startsWith('-')).map((a) => a.toLowerCase());
  const cliLog = inputParameters.includes('-log');
  const logFile = cliLog ? path.join(options.logDir || process.cwd(), `${fileTimestamp()}_CLI.log`) : '';

  const log = (message, emptyLine = false) => {
    if (!cliLog) return;
    try {
      fs.appendFileSync(logFile, (emptyLine ? '\n' : '') + `[${timestamp()}] ${message}\n`);
    } catch (err) {
      print(String(err));
    }
  };

  const out = (message) => {
    print(message);
    log(message);
  };

  const printHelp = () => {
    print('\n' + HELP_TEXT);
    log(HELP_TEXT);
  };

  const mergeROM = (rom) => rom.getMergedROM();

  const processFile = (rom) => {
    let returnCode = 0x0000;
    let commandCtr = 0;

    print(`\nProcessing file ${rom.ROMFullPath}`);
    log(`Processing file ${rom.ROMFullPath}`, true);

    for (let argPos = 2; argPos < args.length; argPos++) {
      switch (args[argPos].toLowerCase()) {
        case '-header': {
          const value = (args[argPos + 1] || '').toLowerCase();

          if (value === 'add') {
            if (rom.SourceROMSMCHeader == null) {
              F.addHeader(rom);
              out('-header: added header');
              returnCode |= 0x0001;
            } else {
              out('-header: header already existing');
            }
          } else if (value === 'remove') {
            if (rom.SourceROMSMCHeader != null) {
              F.removeHeader(rom);
              out('-header: removed header');
              returnCode |= 0x0002;
            } else {
              out('-header: no header found to remove');
            }
          } else {
            return -1;
          }

          commandCtr++;
          argPos++;
          break;
        }

        case '-fixchecksum':
          if (!F.bytesEqual(rom.ByteArrayChecksum, rom.ByteArrayCalcChecksum)) {
            F.fixChecksum(rom);
            out('-fixchecksum: fixed bad checksum');
            returnCode |= 0x0004;
          } else {
            out('-fixchecksum: checksum already OK');
          }
          commandCtr++;
          break;

        case '-fixromsize':
          if (F.needsInternalROMSizeFix(rom)) {
            F.fixInternalROMSize(rom);
            out('-fixromsize: fixed wrong internal ROM size');
            returnCode |= 0x0008;
          } else {
            out('-fixromsize: internal ROM size already OK');
          }
          commandCtr++;
          break;

        case '-removeregion':
          if (F.removeRegionChecks(rom, false)) {
            F.removeRegionChecks(rom);
            out('-removeregion: removed region checks');
            returnCode |= 0x0010;
          } else {
            out('-removeregion: no region checks found');
          }
          commandCtr++;
          break;

        case '-removesram':
          if (F.removeSRAMChecks(rom, false)) {
            F.removeSRAMChecks(rom);
            out('-removesram: removed SRAM checks');
            returnCode |= 0x0020;
          } else {
            out('-removesram: no SRAM checks found');
          }
          commandCtr++;
          break;

        case '-removeslowrom':
          if (rom.ByteROMSpeed === Speed.fast && F.removeSlowROMChecks(rom, false)) {
            F.removeSlowROMChecks(rom);
            out('-removeslowrom: removed SlowROM checks');
            returnCode |= 0x0040;
          } else {
            out('-removeslowrom: no SlowROM checks found');
          }
          commandCtr++;
          break;

        case '-deinterleave':
          if (rom.IsInterleaved) {
            if (C.deinterleave(rom, chooseCopier)) {
              out('-deinterleave: deinterleaved successfully');
              returnCode |= 0x0080;
            } else {
              out('-deinterleave: cancelled by user');
            }
          } else {
            out('-deinterleave: ROM is already deinterleaved');
          }
          commandCtr++;
          break;

        case '-interleave':
          if (!rom.IsInterleaved && (rom.UIntROMHeaderOffset === HeaderOffset.hirom || rom.UIntROMHeaderOffset === HeaderOffset.exhirom)) {
            if (C.interleave(rom, chooseCopier)) {
              out('-interleave: interleaved successfully');
              returnCode |= 0x0100;
            } else {
              out('-interleave: cancelled by user');
            }
          } else if (rom.UIntROMHeaderOffset === HeaderOffset.lorom || rom.UIntROMHeaderOffset === HeaderOffset.exlorom) {
            out('-interleave: interleaving LoROM is not possible');
          } else {
            out('-interleave: ROM is already interleaved');
          }
          commandCtr++;
          break;

        case '-patch': {
          const patchPath = args[argPos + 1];

          if (patchPath && fs.existsSync(patchPath)) {
            const result = applyPatchFile(rom, patchPath);

            if (result.ok) {
              out('-patch: ROM successfully patched');
              returnCode |= 0x0200;
            } else {
              out('-patch: failed to patch ROM' + (result.message ? ` (${result.message})` : ''));
            }
          } else {
            out('-patch: patch file not found');
            return -1;
          }

          commandCtr++;
          argPos++;
          break;
        }

        case '-removeoverdump': {
          const before = rom.SourceROM.length;
          const info = Analysis.removeOverdump(rom);

          if (info) {
            out(`-removeoverdump: removed ${info.type === 'mirror' ? 'mirrored' : 'padded'} data (${before / Analysis.MBIT} -> ${info.realSize / Analysis.MBIT} Mbit)`);
            returnCode |= 0x1000;
          } else {
            out('-removeoverdump: no overdump found');
          }

          commandCtr++;
          break;
        }

        case '-company': {
          const raw = (args[argPos + 1] || '').toUpperCase();

          if (!/^[0-9A-Z]{2}$/.test(raw)) {
            out('-company: invalid code (2 characters 0-9/A-Z expected, f.e. 01)');
            return -1;
          }

          const code = CC.decodeNew(raw.charCodeAt(0), raw.charCodeAt(1));

          if (code === rom.IntCompany) {
            out('-company: company already set');
          } else if (rom.setCompany(code)) {
            out(`-company: set company to ${rom.StringCompany} (${raw})`);
            returnCode |= 0x0800;
          } else {
            out(`-company: code ${raw} cannot be stored in the old header of this ROM (only 1 byte codes 00-FF possible)`);
          }

          commandCtr++;
          argPos++;
          break;
        }

        case '-sram': {
          const raw = args[argPos + 1];
          const value = /^\d+$/.test(raw || '') ? parseInt(raw, 10) : NaN;

          if (!(value >= 0 && value <= 7)) {
            out('-sram: invalid value (allowed: 0-7)');
            return -1;
          }

          const info = rom.getSRAMSizeInfo();

          if (!info.editable) {
            out(`-sram: not possible for this ROM (${info.reason})`);
          } else if (info.value === value) {
            out('-sram: SRAM size already set');
          } else if (rom.setSRAMSize(value)) {
            out(`-sram: set ${info.target === 'exram' ? 'expansion RAM' : 'SRAM'} size to ${value === 0 ? 'none' : `${Math.pow(2, value)} kByte`}`);
            returnCode |= 0x0400;
          }

          commandCtr++;
          argPos++;
          break;
        }

        default:
          break;
      }
    }

    return commandCtr === 0 ? -1 : returnCode;
  };

  const save = (rom, filePath, overwrite) => {
    const ext = path.extname(filePath);
    const savePath = path.join(path.dirname(filePath), path.basename(filePath, ext) + (overwrite ? '' : '-outfile') + ext);
    fs.writeFileSync(savePath, mergeROM(rom));
    out(`Saved file to ${savePath}`);
  };

  const handleReturnCode = (returnCode, rom, savePath) => {
    // 3 = header got added and removed -> doesn't affect the ROM
    // > 0 = success, 0 = nothing, -1 = error
    if (returnCode === -1) {
      out('Execution stopped! Please check your arguments and parameters and try again');
      return -1;
    } else if (returnCode === 3) {
      out('Header add and remove does not affect the ROM -> skipped file');
      return 0;
    } else if (returnCode === 0) {
      out('No executable operation was found -> skipped file');
      return 0;
    }

    save(rom, savePath, inputParameters.includes('-overwrite'));
    return 1;
  };

  const loadAndProcess = (file) => {
    let rom;
    try {
      rom = new SNESROM(file);
    } catch (err) {
      print(`\nProcessing file ${file}`);
      out(err.message);
      return 0;
    }
    return handleReturnCode(processFile(rom), rom, file);
  };

  // Print help if invalid argument was found or user wants to display help
  const invalid = inputParameters.some((p) => !CLI_PARAMETERS.includes(p));

  if (args.length === 0 || invalid || args[0].toLowerCase() === '-help') {
    printHelp();
    return invalid ? 1 : 0;
  }

  if (args[0].toLowerCase() === '-version') {
    const versionText = `${version}.0`;
    print('\n' + versionText);
    log(versionText);
    return 0;
  }

  if (args[0].toLowerCase() === '-path') {
    if (args.length <= 2) {
      out('\nMore arguments needed to proceed execution');
      return 1;
    }

    const target = args[1];

    if (fs.existsSync(target) && fs.statSync(target).isFile() && CLI_FILE_EXTENSIONS.includes(path.extname(target).toLowerCase())) {
      return loadAndProcess(target) === -1 ? 1 : 0;
    }

    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      const files = listFiles(target, inputParameters.includes('-recursive'));
      for (const file of files) {
        if (loadAndProcess(file) === -1) return 1;
      }
      return 0;
    }

    out('\nFile or folder not found');
    return 1;
  }

  printHelp();
  return 0;
}

/** Synchronous terminal prompt for choosing a copier format (Node.js CLI) */
function terminalCopierPrompt(text) {
  const prompt = `\n${text}\n\n  [1] Game Doctor SF\n  [2] Super UFO\n  [3] Standard\n  [4] Cancel\n\nChoose an option (1-4): `;
  process.stdout.write(prompt);

  const buf = Buffer.alloc(16);
  let input = '';
  try {
    const n = fs.readSync(0, buf, 0, buf.length, null);
    input = buf.toString('utf8', 0, n).trim();
  } catch {
    input = '4';
  }

  switch (input) {
    case '1': return 'gd';
    case '2': return 'ufo';
    case '3': return 'standard';
    default: return 'cancel';
  }
}

module.exports = { run, terminalCopierPrompt, HELP_TEXT, CLI_PARAMETERS };
