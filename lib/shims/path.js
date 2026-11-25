'use strict';

// Browser replacement for the parts of Node's "path" used by the core.
// Works with Windows ("C:\ROMs\game.sfc") and POSIX paths ("/home/user/game.sfc").

const isSep = (c) => c === '/' || c === '\\';

function lastSep(p) {
  for (let i = p.length - 1; i >= 0; i--) {
    if (isSep(p[i])) return i;
  }
  return -1;
}

function stripTrailing(p) {
  let end = p.length;
  while (end > 1 && isSep(p[end - 1]) && !(end === 3 && p[1] === ':')) end--;
  return p.slice(0, end);
}

function basename(p, ext) {
  const s = stripTrailing(String(p));
  let base = s.slice(lastSep(s) + 1);
  if (ext && base !== ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
  return base;
}

function dirname(p) {
  const s = stripTrailing(String(p));
  const i = lastSep(s);
  if (i < 0) return '.';
  if (i === 0) return s[0];                          // "/file"
  if (i === 2 && s[1] === ':') return s.slice(0, 3);  // "C:\file"
  return s.slice(0, i);
}

function extname(p) {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i);
}

function join(...parts) {
  const list = parts.map(String).filter((x) => x.length > 0);
  if (list.length === 0) return '.';
  const sep = list.some((x) => x.includes('\\')) ? '\\' : '/';
  let out = list[0];
  for (const part of list.slice(1)) {
    out = (isSep(out[out.length - 1]) ? out : out + sep) + part.replace(/^[\\/]+/, '');
  }
  return out;
}

module.exports = {
  basename,
  dirname,
  extname,
  join,
  resolve: (...parts) => join(...parts),
  sep: '/',
};
