'use strict';
// agentspur – storage: objects by content hash, a JSONL timeline, and the last known state.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = '.agentspur';
const MAX_OBJECT_BYTES = 20 * 1024 * 1024; // larger files are logged, not copied
const ALWAYS_IGNORE = [DIR, '.git', 'node_modules', '.DS_Store', 'Thumbs.db', '.hg', '.svn'];

function findRoot(start) {
  // Walk up to find an existing .agentspur; otherwise the start directory is the root.
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, DIR))) return d;
    const up = path.dirname(d);
    if (up === d) return path.resolve(start);
    d = up;
  }
}

class Store {
  constructor(root) {
    this.root = root;
    this.dir = path.join(root, DIR);
    this.objects = path.join(this.dir, 'objects');
    this.logFile = path.join(this.dir, 'log.jsonl');
    this.stateFile = path.join(this.dir, 'state.json');
    this.lockFile = path.join(this.dir, 'lock');
    this.ignore = loadIgnore(root);
  }
  exists() { return fs.existsSync(this.dir); }
  init() {
    fs.mkdirSync(this.objects, { recursive: true });
    if (!fs.existsSync(this.logFile)) fs.writeFileSync(this.logFile, '');
    if (!fs.existsSync(this.stateFile)) fs.writeFileSync(this.stateFile, '{}');
    const gi = path.join(this.dir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  }

  // ---- ignore rules ----
  ignored(rel) {
    const parts = rel.split('/');
    if (parts.some(p => ALWAYS_IGNORE.includes(p))) return true;
    return this.ignore.some(re => re.test(rel));
  }

  // ---- locking (simple, cross-platform, retrying) ----
  withLock(fn) {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // stale lock? (older than 30 s)
        try {
          const st = fs.statSync(this.lockFile);
          if (Date.now() - st.mtimeMs > 30000) { fs.unlinkSync(this.lockFile); continue; }
        } catch (_) { continue; }
        if (Date.now() > deadline) throw new Error('agentspur: could not acquire lock (' + this.lockFile + ')');
        sleepMs(25);
      }
    }
    try { return fn(); }
    finally { try { fs.unlinkSync(this.lockFile); } catch (_) {} }
  }

  // ---- objects ----
  putObject(absPath) {
    // returns {hash, size, stored}
    const st = fs.statSync(absPath);
    if (st.size > MAX_OBJECT_BYTES) {
      return { hash: 'large:' + st.size + ':' + Math.floor(st.mtimeMs), size: st.size, stored: false };
    }
    const buf = fs.readFileSync(absPath);
    const hash = sha(buf);
    const dst = path.join(this.objects, hash);
    if (!fs.existsSync(dst)) {
      fs.writeFileSync(dst + '.tmp', buf);
      fs.renameSync(dst + '.tmp', dst);
    }
    return { hash, size: st.size, stored: true };
  }
  hasObject(hash) { return !!hash && !hash.startsWith('large:') && fs.existsSync(path.join(this.objects, hash)); }
  readObject(hash) { return fs.readFileSync(path.join(this.objects, hash)); }

  // ---- state (path -> {hash,size,mtime}) ----
  readState() { try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch (_) { return {}; } }
  writeState(state) {
    fs.writeFileSync(this.stateFile + '.tmp', JSON.stringify(state));
    fs.renameSync(this.stateFile + '.tmp', this.stateFile);
  }

  // ---- log ----
  readLog() {
    const txt = fs.readFileSync(this.logFile, 'utf8');
    const out = [];
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (_) {}
    }
    return out;
  }
  lastN() {
    const log = this.readLog();
    return log.length ? log[log.length - 1].n : 0;
  }
  appendEntries(entries) {
    // entries without n; numbers them, writes them, returns them
    let n = this.lastN();
    const lines = entries.map(e => { e.n = ++n; return JSON.stringify(e); });
    fs.appendFileSync(this.logFile, lines.join('\n') + '\n');
    return entries;
  }

  // ---- scanning the working tree ----
  scan() {
    // returns Map rel -> {size, mtime}
    const out = new Map();
    const walk = (dir, relDir) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const ent of ents) {
        const rel = relDir ? relDir + '/' + ent.name : ent.name;
        if (this.ignored(rel)) continue;
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(abs, rel);
        else if (ent.isFile()) {
          try { const st = fs.statSync(abs); out.set(rel, { size: st.size, mtime: Math.floor(st.mtimeMs) }); } catch (_) {}
        }
      }
    };
    walk(this.root, '');
    return out;
  }

  // Compare the tree (or a subset of paths) with the known state and record what changed.
  // source: 'agent' for watched changes, 'restore' for our own restores.
  record(paths, source, opts = {}) {
    return this.withLock(() => {
      const state = this.readState();
      const entries = [];
      const now = new Date().toISOString();
      const consider = paths || new Set([...Object.keys(state), ...this.scan().keys()]);
      for (const rel of consider) {
        if (this.ignored(rel)) continue;
        const abs = path.join(this.root, rel);
        const prev = state[rel];
        let st = null;
        try { st = fs.statSync(abs); if (!st.isFile()) st = null; } catch (_) {}
        if (!st && !prev) continue;
        if (!st && prev) {
          entries.push({ t: now, op: 'delete', path: rel, before: prev.hash, after: null, sizeBefore: prev.size, sizeAfter: 0, by: source });
          delete state[rel];
          continue;
        }
        // quick skip: same size and mtime as known
        if (prev && prev.size === st.size && prev.mtime === Math.floor(st.mtimeMs) && !opts.force) continue;
        let obj;
        try { obj = this.putObject(abs); } catch (_) { continue; } // file vanished mid-read
        if (prev && prev.hash === obj.hash) { state[rel] = { hash: obj.hash, size: obj.size, mtime: Math.floor(st.mtimeMs) }; continue; }
        entries.push({
          t: now, op: prev ? 'change' : 'add', path: rel,
          before: prev ? prev.hash : null, after: obj.hash,
          sizeBefore: prev ? prev.size : 0, sizeAfter: obj.size, by: source
        });
        state[rel] = { hash: obj.hash, size: obj.size, mtime: Math.floor(st.mtimeMs) };
      }
      if (entries.length) this.appendEntries(entries);
      this.writeState(state);
      return entries;
    });
  }

  // State as it was right BEFORE entry n (or at the current time if n > last).
  stateBefore(n) {
    const state = this.readState();
    const log = this.readLog();
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (e.n < n) break;
      if (e.op === 'start') continue;
      if (e.before) state[e.path] = { hash: e.before, size: e.sizeBefore };
      else delete state[e.path];
    }
    return state;
  }
}

function loadIgnore(root) {
  const f = path.join(root, '.agentspurignore');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n')
    .map(s => s.trim()).filter(s => s && !s.startsWith('#'))
    .map(globToRegex);
}
function globToRegex(glob) {
  // supports *, **, ?, leading / (anchor), trailing / (directory)
  let g = glob.replace(/\/+$/, '');
  const anchored = g.startsWith('/');
  if (anchored) g = g.slice(1);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  // match the whole path, or any path segment start if not anchored; also anything beneath
  return new RegExp((anchored ? '^' : '(^|/)') + re + '(/|$)');
}
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

module.exports = { Store, findRoot, DIR, MAX_OBJECT_BYTES, globToRegex };
