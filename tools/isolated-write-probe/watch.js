'use strict';
// Records how Claude Code writes its history files (constraint 0, STORAGE_ARCHITECTURE.md 5c amendments).
// Read-only towards the probe profile: it only stats and reads files under the given config directory.
// For each file in projects/, file-history/ and image-cache/ it logs, on every change:
//   identity (bigint dev:ino), size, whether the previous content is a byte prefix of the new content,
//   and whether the file identity changed (replace-by-rename) or the file disappeared.
// Usage: node watch.js <configDir> <logFile>
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [configDir, logFile] = process.argv.slice(2);
if (!configDir || !logFile) { console.error('usage: node watch.js <configDir> <logFile>'); process.exit(2); }
const watched = ['projects', 'file-history', 'image-cache'];
const state = new Map(); // relative path -> { id, size, mtimeMs, sha }
let marker = 'start';
const log = event => fs.appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), marker, ...event }) + '\n');
const sha = (file, length) => {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let done = 0;
    while (done < length) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, length - done), done);
      if (!n) break;
      hash.update(buf.subarray(0, n)); done += n;
    }
    return done === length ? hash.digest('hex') : null;
  } finally { fs.closeSync(fd); }
};
function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
}
function scan() {
  const seen = new Set();
  for (const name of watched) {
    const files = [];
    walk(path.join(configDir, name), files);
    for (const file of files) {
      const rel = path.relative(configDir, file);
      seen.add(rel);
      let st;
      try { st = fs.statSync(file, { bigint: true }); } catch { continue; }
      const id = `${st.dev}:${st.ino}`, size = Number(st.size), mtimeMs = Number(st.mtimeMs);
      const prev = state.get(rel);
      if (prev && prev.id === id && prev.size === size && prev.mtimeMs === mtimeMs) continue;
      let full;
      try { full = sha(file, size); } catch { continue; }
      if (!prev) { log({ event: 'created', rel, id, size, nlink: Number(st.nlink) }); }
      else {
        let prefix = null;
        try { prefix = size >= prev.size ? sha(file, prev.size) === prev.sha : false; } catch { /* changed again */ }
        const kind = prev.id !== id ? 'replaced (new file identity)' : prefix ? 'appended (old content is a prefix)' : size < prev.size ? 'TRUNCATED IN PLACE' : 'REWRITTEN IN PLACE';
        log({ event: 'changed', kind, rel, idBefore: prev.id, idAfter: id, sizeBefore: prev.size, sizeAfter: size, nlink: Number(st.nlink) });
      }
      state.set(rel, { id, size, mtimeMs, sha: full });
    }
  }
  for (const rel of [...state.keys()]) if (!seen.has(rel)) { log({ event: 'deleted', rel, idBefore: state.get(rel).id }); state.delete(rel); }
}
// The operator types a step name in this window to label the following events.
process.stdin.setEncoding('utf8');
process.stdin.on('data', text => { const m = text.trim(); if (m) { marker = m; log({ event: 'step', step: m }); console.log(`step: ${m}`); } });
log({ event: 'watch-start', configDir });
console.log(`Watching ${configDir}\nType the name of each step here (for example "turn", "compact", "rewind") and press Enter before doing it.`);
setInterval(() => { try { scan(); } catch (e) { log({ event: 'error', message: e.message }); } }, 150);
