'use strict';

// Browser replacement for the parts of Node's "fs" used by the core.
//
// The webview cannot access files synchronously, but the core (ported from C#) is synchronous.
// So the app reads files asynchronously through Tauri first and puts them into this in-memory
// file table (put / putStat). Files written by the core (split, swapbin) are collected and
// written to disk by the app afterwards (takeWrites).

const files = new Map(); // path -> { size, data: Uint8Array|null }
const writes = [];

function notFound(p) {
  const err = new Error(`ENOENT: no such file or directory, '${p}'`);
  err.code = 'ENOENT';
  return err;
}

function entry(p) {
  const e = files.get(String(p));
  if (!e) throw notFound(p);
  return e;
}

const vfs = {
  /** Makes a file readable for the core */
  put(p, data) {
    files.set(String(p), { size: data.length, data });
  },
  /** Only announces a file and its size (f.e. files that are too large to be loaded) */
  putStat(p, size) {
    files.set(String(p), { size, data: null });
  },
  drop(p) {
    files.delete(String(p));
  },
  clear() {
    files.clear();
  },
  /** Returns and forgets all files written by the core since the last call */
  takeWrites() {
    const list = writes.splice(0);
    for (const w of list) files.delete(w.path);
    return list;
  },
};

module.exports = {
  __vfs: vfs,

  existsSync(p) {
    return files.has(String(p));
  },

  statSync(p) {
    const e = entry(p);
    return { size: e.size, isFile: () => true, isDirectory: () => false };
  },

  readFileSync(p, encoding) {
    const e = entry(p);
    if (!e.data) throw notFound(p);
    if (encoding) return new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding).decode(e.data);
    return e.data;
  },

  writeFileSync(p, data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    writes.push({ path: String(p), data: bytes });
    files.set(String(p), { size: bytes.length, data: bytes });
  },
};
