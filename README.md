# Advanced SNES ROM Utility JS

An easy to use utility for performing some tasks on SNES / SFC ROMs – now for **Windows, macOS and Linux**!

This is a port of the C# / Windows Forms application
[Advanced SNES ROM Utility](https://github.com/Dom-aka-Doke/Advanced-SNES-ROM-Utility) (based on version 1.3). The goal of the port is to bring the tool to more operating systems while keeping
its look and behaviour. Along the way it got a couple of new features, fixes and a modern design.

It is built with [Tauri](https://tauri.app): the ROM logic runs as JavaScript, the window uses the web view
that is already part of the operating system. That keeps the application small – about **3.5 MB** as a
single Windows executable, compared to over 100 MB for a typical Electron app.

---

## Contents

- [Functions](#functions)
- [Options](#options)
- [Commandline (CLI)](#commandline-cli)
- [Some notes about BS-X ROMs](#some-notes-about-bs-x-roms)
- [Download and installation](#download-and-installation)
- [Building from source](#building-from-source)
- [Project structure](#project-structure)
- [License](#license)

---

## Functions

### Edit Header Information
Change basic header information:

- **Title** – Japanese (Shift-JIS) characters are supported. The title is limited by bytes, not by characters
  (21 bytes for most ROMs). A double byte character is never cut in half: if it doesn't fit anymore, it is
  dropped and the title is padded with a space.
- **Company** – see [Change Company](#change-company).
- **Country / Region** – not available for BS-X ROMs (they have no region code).
- **Version** – `1.0` to `1.255`.
- **Game Code** – only available for ROMs with an extended header; only `A-Z` and `0-9` are accepted.
- **(S)RAM size** – see [Change (S)RAM Size](#change-sram-size).

### Change Company
The company is stored in two different ways:

- **Old header:** one byte at `$FFDA`. Only companies with a one byte code can be chosen.
- **Extended header** (`$FFDA` = `0x33`): a two character maker code at `$FFB0`.

The tool converts between both formats automatically. Codes are shown the way they are commonly listed,
e.g. `01` for Nintendo or `A4` for Konami.

### Change (S)RAM Size
Choose the size of the battery backed SRAM (none, 2 kByte … 128 kByte).

- Normal ROMs store the size at `$FFD8`.
- Super FX games use the expansion RAM field `$FFBD` of the extended header instead.
- Early Super FX games without an extended header (e.g. **Star Fox / Star Wing**) have no field for the
  size at all – here the option is locked.

### Add Header
Adds an empty 512 byte copier header.

### Remove Header
Removes an existing header.

### Fix Checksum
Fixes a broken checksum. You always should do this before saving, if possible. Please note that some beta
or demo ROMs have an odd checksum anyway...

The light next to **Checksums** shows the state: green = internal checksum is correct, red = it doesn't match.

### Fix Internal ROM Size
Fixes wrong internal ROM size information. Do this after expanding or removing an overdump.
Also useful to fix some ROM hacks.

### Expand ROM
Expands the ROM to a specific size up to 64 Mbit (BS-X up to 32 Mbit). Use **Expand fill** to choose how
the new space is filled:

| Expand fill | Use it for |
|---|---|
| **Empty (0x00)** | ROM hacks – free space for your own code and data (default) |
| **Empty (0xFF)** | Same, but filled like an erased (E)EPROM / flash chip |
| **Mirror data** | Writing a smaller game to a larger chip, e.g. an 8 Mbit game to a 16 Mbit EPROM: the game sees the same data as on the original cartridge |

- *Mirror data* follows the address decoding of the SNES, so it also works for games whose size is no power
  of two (e.g. a 12 Mbit game on a 16 Mbit chip). Target sizes that cannot be mirrored correctly
  (12, 20, 24 and 28 Mbit) are not offered with this option.
- **48 / 64 Mbit:** LoROM and HiROM games are converted to **ExLoROM / ExHiROM**. The map mode is changed and
  the parts the SNES reads from the upper area are copied, so the game still starts.
- Games with enhancement chips that use their own mapping (SA-1, S-DD1, SPC7110, Super FX) and interleaved
  ROMs can be expanded as well, but only free space is added – data and header stay untouched.
- Homebrew ROMs smaller than 1 Mbit can also be expanded to 512 Kbit.

> **Note**<br>
> Expanding doesn't change the header for you. Afterwards use **Fix Internal ROM Size** and
> **Fix Checksum**. Always check if your ROM still works after expanding!

### Split ROM
Splits ROM into equal sized multiple parts, e.g. for programming several (E)EPROMs.

### SwapBin ROM (27C801)
Swaps binaries to get a *"Close-to-SNES-Mask-ROM"*-layout. <br>
Use 27C801 (E)EPROM and rewire pins as followed:

|  27C801       | Nintendo Mask ROM |
|:-------------:|:-----------------:|
| 24            | 31                |
| 31            | 24                |

ROMs larger than 8 Mbit are split into 8 Mbit parts first. An existing header is removed.

### Deinterleave
Some copy stations like "Game Doctor SF" or "Super UFO" use interleaving when dumping HiROM games. This
function will reverse this process. Please use ROMs with copy station header, unless you know which copy
station was used! For 20, 24 and 48 Mbit ROMs without header the tool asks for the copy station.

### Interleave
Some patches or copy stations require interleaved HiROMs. This function will interleave your HiROM. If you
have interleaved a ROM, patched it and want to play it in an emulator, flashcard or make a physical copy,
don't forget to deinterleave and fix checksum again!
> **Note**<br>
> Only HiROMs can be interleaved!

### Remove Region Locks
Some games have a copy protection preventing the ROM from running on systems with another region (PAL/NTSC
lock). Use this function to remove most known region locks.

### Remove SRAM Checks
Some games have a copy protection preventing the ROM from running, when cartridges have more SRAM than
needed (copy stations / some cheap flashcards / deprecated emulators). Use this function to remove most
known SRAM checks.

### Remove SlowROM Checks
Useful if you want to play your FastROM on a copy station without FastROM support or make a physical copy
using an (E)EPROM / flash ROM slower than 120 ns.

### Convert HiROM <-> LoROM
Can switch ROM layout between HiROM and LoROM. If the ROM uses (S)RAM or some enhancement chips, you have
to do some manual work after conversion.
> **Note**<br>
> Converting from HiROM to LoROM only works, if the ROM was designed to be convertible.

### Remove Overdump
An overdump is a ROM file that is larger than the real chip, because the dumper read more than was there.
The tool recognizes two kinds:

- **Padded data** – the file is larger than its internal size and the rest only contains `0x00` or `0xFF`.
- **Mirrored data** – the end of the file repeats data from before, exactly as the SNES would see it on a
  smaller chip.

The button is only active if an overdump was found. The tool shows the detected sizes and asks before
cutting the file. Afterwards use **Fix Internal ROM Size**, if the tool tells you so.

### ROM Heatmap
Opens a map of all ROM banks:

- **Duplicates** view: unique banks, banks that are identical to another bank (same color per group),
  empty banks (only `0x00` / `0xFF`) and the bank with the internal header.
- **Entropy** view: how "random" the data of each bank is – compressed graphics and music look different
  from code or empty space.
- The bank size follows the map mode (32 kByte for LoROM, 64 kByte for HiROM) and can be switched.
- A list of all identical banks and the overdump result are shown below the map.

Useful to spot overdumps, free space for ROM hacks or bad dumps. The window updates when the ROM changes.

### Apply Patch
Patch your loaded ROM!
 - IPS
   - RLE hunks
   - truncating
   - avoids EOF offset bug
 - UPS
   - revert a patch, if applied a second time (the result is verified)
 - BPS
 - BDF
 - XDELTA (VCDIFF; patches with secondary compression, `xdelta3 -S`, are not supported)
> **Note**<br>
> If you have a __BDF__ patch file with __.bdiff__ extension, try to change this into __.bdf__ <br>
> Also try renaming __XDELTA__ patches ending to __.vcdiff__ into __.xdelta__

### Scan
Scan / rescan ROM for copy protections.

### Open, Save and Save As
- Open ROMs with **Select ROM File**, *File → Open* (<kbd>Ctrl</kbd>+<kbd>O</kbd>), by dragging a file onto
  the window or by starting the application with a ROM file (e.g. "Open with").
- The open dialog starts in the folder of the last opened ROM. If that folder doesn't exist anymore, your
  documents folder is used.
- Supported file extensions: `.sfc`, `.smc`, `.swc`, `.fig` (any other file can be opened as well).
- When closing the window with unsaved changes, the tool asks whether to save them.

### Run in Emulator
Starts the current state of the ROM – including unsaved changes – in your emulator with <kbd>F5</kbd>
(*File → Run in Emulator*). Choose the emulator once with *Options → Set Emulator…*; without one, <kbd>F5</kbd>
asks you to choose it.
- **Windows:** the program file, e.g. `snes9x-x64.exe` or `Mesen.exe`. **macOS:** the app, e.g. `Snes9x.app`
  or `OpenEmu.app`. **Linux:** the program, e.g. `/usr/bin/snes9x-gtk`.
- **Arguments:** `%ROM%` is replaced by the path of the ROM. The default `"%ROM%"` works for most emulators;
  RetroArch needs the core, e.g. `-L cores/snes9x_libretro.dll "%ROM%"`.
- A temporary copy with the same file name is started – your original file stays untouched. The copies are
  deleted when the tool closes; save files (`.srm`) of the emulator are kept between test runs.

---

## Options

The *Options* menu contains **Reset Options**, **Scan ROM on loading** and **Set Emulator…**.

- **Expand fill** – how new space is filled when expanding a ROM (see [Expand ROM](#expand-rom)).
- **Scan ROM on loading**
  - Checked – the ROM is scanned for copy protections instantly on loading. This might take a few seconds.
  - Unchecked – you have to click the **Scan** button to check for copy protections.
- **Design** (*View* menu) – modern or classic look; <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> toggles.
- **Set Emulator…** (*Options* menu) – emulator for [Run in Emulator](#run-in-emulator).
- **Reset Options** (*Options* menu) – restores all settings (incl. the emulator) and all dialog messages you
  have hidden with *"Don't show this message again"*.

All settings are saved automatically. Settings of a previous Electron version are taken over on the first start.

---

## Commandline (CLI)

- Use the commandline for executing batch operations (or just for processing a single file, if you prefer
  using the commandline).
- Build your own command chain to execute operations in the order you specified!
- The CLI runs with [Node.js](https://nodejs.org) on Windows, macOS and Linux:
  `node cli.js [options]` (or `npm run cli -- [options]`) in the source folder.
- Deinterleaving and interleaving might need a decision about the copy station – the CLI asks for it in the
  terminal.

__Example:__

```
node cli.js -path "C:\ROMs" -recursive -header add -patch "C:\Patches\patch.ips" -header remove -fixromsize -fixchecksum
```

This command will add a header to all ROMs in `C:\ROMs` (subfolders included), apply an IPS patch, remove the
header afterwards, fix internal ROM size and checksum and save the modified file with an extension.

| Option | Description |
|---|---|
| `-path <FILEPATH, FOLDER>` | Path or folder of the ROM file(s) |
| `-recursive` | Include files from subdirectories |
| `-overwrite` | Overwrite files on saving (else an extension will be used) |
| `-header <add, remove>` | Adds or removes a header |
| `-fixchecksum` | Fixes a broken checksum |
| `-fixromsize` | Fixes a wrong internal ROM size |
| `-removeregion` | Removes existing region checks |
| `-removesram` | Removes existing SRAM checks |
| `-removeslowrom` | Removes existing SlowROM checks |
| `-deinterleave` | Deinterleave, if ROM is in interleaved format |
| `-interleave` | Interleave, if ROM is in deinterleaved format |
| `-patch <FILEPATH>` | Patch ROM with a specific patch |
| `-removeoverdump` | **New:** removes mirrored or padded data of an overdumped ROM |
| `-company <CODE>` | **New:** sets the company by its 2 character code (e.g. `01` = Nintendo, `A4` = Konami) |
| `-sram <0-7>` | **New:** sets the (S)RAM size: `0` = none, `n` = 2^n kByte (`1` = 2 kByte … `7` = 128 kByte) |
| `-log` | Write output to a logfile |
| `-version` | Show version information |
| `-help` | Show help and usage information |

For more information type `node cli.js -help` or take a look into the tool's manual (<kbd>F1</kbd>).

---

## Some notes about BS-X ROMs
- Checksum doesn't include header information (it won't change if you edit values)
- There's no region code (JP only)
- ROM size is limited to a maximum of 32 Mbit

---

## Download and installation

Ready to use packages are attached to the releases of this repository.

| System | Package | Requirements |
|---|---|---|
| Windows 10 / 11 | `…_x64-setup.exe` (installer) or `…-Portable.exe` (no installation) | WebView2 – part of Windows 10/11; the installer downloads it if missing |
| macOS 10.15+ | `.dmg` (Intel and Apple Silicon) | – |
| Linux | `.deb` or `.AppImage` | WebKitGTK 4.1 (`libwebkit2gtk-4.1-0`), present on most desktop distributions |

> **Note**<br>
> The packages are not signed with a paid certificate. On Windows, SmartScreen may warn on the first start
> (*More info → Run anyway*). On macOS, right click the app → *Open* on the first start. If macOS reports the
> app as "damaged", run `xattr -cr "/Applications/Advanced SNES ROM Utility JS.app"` in the terminal.

The original Windows version (C#) is available on [RHDN](https://www.romhacking.net/utilities/1638).

---

## Building from source

### Requirements
- [Node.js](https://nodejs.org) 20 or newer
- [Rust](https://rustup.rs) (stable)
- **Windows:** Visual Studio C++ Build Tools ("Desktop development with C++")
- **Linux:** `build-essential file libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf`
- **macOS:** Xcode Command Line Tools

On Windows, just double click `setup-windows.cmd` – it checks and installs everything above
(log: `setup.log`). Then double click `build-windows.cmd`; the packages are copied to `dist\`.

### Commands

```bash
npm install          # install the Tauri CLI
npm run dev          # start the app in development mode
npm test             # run the tests (core + browser replacements)
npm run build:win    # Windows installer (NSIS)
npm run build:linux  # .deb + AppImage (on Linux)
npm run build:mac    # .app + .dmg (on macOS)
node cli.js -help    # commandline
```

The first build takes 5–15 minutes, later builds about 2 minutes.

### Build pipeline (GitHub Actions)

`.github/workflows/build.yml` builds the packages for all three systems on GitHub – no Mac needed
(macOS as universal build for Intel and Apple Silicon).

| Trigger | Result |
|---|---|
| Push to `main` / `dev`, pull request | Tests and builds; packages attached to the run as *Artifacts* |
| *Actions* → *Build* → *Run workflow* | The same, started manually |
| Tag `v*`, e.g. `v2.1.0` | Additionally a GitHub release with all packages |

To publish a new version, raise the version in `package.json`, `src-tauri/Cargo.toml`,
`src-tauri/tauri.conf.json` and `lib/version.js`, commit, then:

```bash
git tag v2.1.0
git push origin v2.1.0
```

---

## Project structure

```
lib/core/               ROM logic (the same JavaScript core as the Electron port)
lib/shims/              browser replacements for the Node.js modules fs, path and crypto
lib/cli/                commandline
scripts/bundle-core.js  bundles lib/ into one browser script (web/js/core.bundle.js)
web/                    user interface
  index.html, renderer.js, styles.css   main window
  js/app.js             controller of the main window
  js/platform.js        files, dialogs, windows and events via Tauri
  js/modal.js           message boxes inside the window
  js/bridge-child.js    connection of the manual, about and heatmap windows
src-tauri/              Rust backend: file access, settings, menu, windows
test/                   tests (npm test)
cli.js                  commandline entry point
```

**How it works:** the ROM logic is synchronous (like the C# original), but a web view can only read files
asynchronously. So the app first reads a file through the Rust backend and puts it into a small in-memory
file table (`lib/shims/fs.js`); the core then works on it as usual. Files written by the core (Split,
SwapBin) are collected there and written to disk afterwards. MD5, SHA-1 and SHA-256 are implemented in plain
JavaScript (`lib/shims/crypto.js`), because the web crypto API is asynchronous and has no MD5.

---

## License

[GPL-3.0](LICENSE), like the original C# application.
