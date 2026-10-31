#!/usr/bin/env node
'use strict';
// agentspur – records what agents change in a folder, and brings it back.
// https://github.com/idmandat/agentspur
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Store, findRoot, DIR, MAX_OBJECT_BYTES } = require('./store');
const { render } = require('./diff');
const VERSION = require('./package.json').version;

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const words = args.filter(a => !a.startsWith('--'));
const cmd = words[0];
const color = !!process.stdout.isTTY && !flags.has('--no-color');
const B = color ? '\x1b[1m' : '', D = color ? '\x1b[2m' : '', R = color ? '\x1b[31m' : '', G = color ? '\x1b[32m' : '', Y = color ? '\x1b[33m' : '', X = color ? '\x1b[0m' : '';

function help() {
  console.log(`${B}agentspur${X} ${VERSION} – records what agents change in this folder, and brings it back.

  ${B}agentspur watch${X}            start recording in this folder (leave it running)
  ${B}agentspur log${X} [--all]      show the timeline (last 40 steps, or all)
  ${B}agentspur diff${X} <step>      show what changed in one step
  ${B}agentspur show${X} <step>      print the file as it was after that step
  ${B}agentspur back${X} <step>      return every file to how it was ${B}before${X} that step
  ${B}agentspur back${X} <HH:MM>     return to that time today
  ${B}agentspur status${X}           what is recorded, how much space it takes

  Everything lives in ${DIR}/ inside the folder. Delete it and agentspur is gone.
  ${D}Patterns in .agentspurignore are left out. .git, node_modules and ${DIR} always are.${X}
`);
}

function openStore(mustExist) {
  const root = findRoot(process.cwd());
  const s = new Store(root);
  if (!s.exists() && mustExist) {
    console.error(`agentspur: nothing recorded here. Run ${B}agentspur watch${X} in the folder first.`);
    process.exit(1);
  }
  return s;
}

function fmtTime(iso) { const d = new Date(iso); return d.toTimeString().slice(0, 8); }
function fmtDate(iso) { return iso.slice(0, 10); }
function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
function opColor(op) { return op === 'add' ? G : op === 'delete' ? R : op === 'restore' ? Y : ''; }

// ---------------------------------------------------------------- watch
function watch() {
  const root = process.cwd();
  const s = new Store(root);
  const fresh = !s.exists();
  s.init();
  if (fresh || Object.keys(s.readState()).length === 0) {
    // baseline: remember everything as it is now, without listing it as changes
    s.withLock(() => {
      const state = {};
      for (const [rel] of s.scan()) {
        try { const o = s.putObject(path.join(root, rel)); const st = fs.statSync(path.join(root, rel)); state[rel] = { hash: o.hash, size: o.size, mtime: Math.floor(st.mtimeMs) }; } catch (_) {}
      }
      s.writeState(state);
      s.appendEntries([{ t: new Date().toISOString(), op: 'start', path: '', files: Object.keys(state).length, by: 'agentspur' }]);
      console.log(`${B}agentspur${X} is watching ${root}`);
      console.log(`${D}${Object.keys(state).length} files remembered as the starting point.${X}`);
    });
  } else {
    // catch up on anything that changed while we were not running
    const missed = s.record(null, 'unwatched');
    s.appendEntries([{ t: new Date().toISOString(), op: 'start', path: '', by: 'agentspur' }]);
    console.log(`${B}agentspur${X} is watching ${root}`);
    if (missed.length) console.log(`${D}${missed.length} change(s) happened while agentspur was not running; recorded them as "unwatched".${X}`);
  }
  console.log(`${D}Stop with Ctrl+C. Timeline: agentspur log${X}\n`);

  const pending = new Set();
  let timer = null;
  const flush = () => {
    timer = null;
    let paths = new Set(pending); pending.clear();
    // a folder appeared, vanished or was renamed: look at everything, not just the named path
    for (const rel of paths) {
      try { if (fs.statSync(path.join(root, rel)).isDirectory()) { paths = null; break; } }
      catch (_) { paths = null; break; }
    }
    let entries = [];
    try { entries = s.record(paths, 'agent'); } catch (e) { console.error('agentspur:', e.message); }
    for (const e of entries) printEntry(e);
  };
  const queue = (rel) => {
    if (!rel) return;
    rel = rel.split(path.sep).join('/');
    if (s.ignored(rel)) return;
    // a directory event: rescan everything beneath it on the next full pass
    pending.add(rel);
    if (!timer) timer = setTimeout(flush, 250);
  };
  let watcher = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (ev, filename) => queue(filename ? String(filename) : null));
    watcher.on('error', () => {});
  } catch (e) {
    console.log(`${D}(fast file events not available here, falling back to scanning every 2 s)${X}`);
  }
  // safety net: a full pass now and then catches anything the events missed (renamed folders, odd editors)
  setInterval(() => {
    try { for (const e of s.record(null, 'agent')) printEntry(e); } catch (_) {}
  }, watcher ? 5000 : 2000);
  process.on('SIGINT', () => { console.log(`\n${D}agentspur stopped. Everything is kept in ${DIR}/.${X}`); process.exit(0); });
}
function printEntry(e) {
  const c = opColor(e.op);
  const delta = e.op === 'delete' ? `${D}was ${fmtSize(e.sizeBefore)}${X}` : e.op === 'add' ? `${D}${fmtSize(e.sizeAfter)}${X}` : `${D}${fmtSize(e.sizeBefore)} -> ${fmtSize(e.sizeAfter)}${X}`;
  console.log(`${D}#${String(e.n).padStart(4)}${X}  ${fmtTime(e.t)}  ${c}${e.op.padEnd(7)}${X} ${e.path}  ${delta}`);
}

// ---------------------------------------------------------------- log
function log() {
  const s = openStore(true);
  let entries = s.readLog();
  if (!entries.length) { console.log('Nothing recorded yet.'); return; }
  const all = flags.has('--all');
  const shown = all ? entries : entries.slice(-40);
  if (!all && entries.length > shown.length) console.log(`${D}... ${entries.length - shown.length} earlier step(s), use --all to see them${X}`);
  let day = '';
  for (const e of shown) {
    if (fmtDate(e.t) !== day) { day = fmtDate(e.t); console.log(`${B}${day}${X}`); }
    if (e.op === 'start') { console.log(`${D}#${String(e.n).padStart(4)}  ${fmtTime(e.t)}  started watching${e.files != null ? ` (${e.files} files)` : ''}${X}`); continue; }
    printEntry(e);
  }
  console.log(`\n${D}agentspur diff <step> shows one change. agentspur back <step> undoes from that step on.${X}`);
}

// ---------------------------------------------------------------- diff / show
function findEntry(s, n) {
  const e = s.readLog().find(x => x.n === n);
  if (!e) { console.error(`agentspur: no step #${n}. See agentspur log.`); process.exit(1); }
  return e;
}
function diff() {
  const s = openStore(true);
  const n = parseInt(words[1], 10);
  if (!n) { console.error('usage: agentspur diff <step>'); process.exit(1); }
  const e = findEntry(s, n);
  if (e.op === 'start') { console.log(`#${n}: started watching.`); return; }
  console.log(`${B}#${e.n}${X}  ${fmtDate(e.t)} ${fmtTime(e.t)}  ${opColor(e.op)}${e.op}${X}  ${e.path}`);
  const a = e.before && s.hasObject(e.before) ? s.readObject(e.before) : null;
  const b = e.after && s.hasObject(e.after) ? s.readObject(e.after) : null;
  if ((e.before && !a) || (e.after && !b)) { console.log(`  ${D}(file larger than ${fmtSize(MAX_OBJECT_BYTES)}: only the fact of the change was recorded, ${fmtSize(e.sizeBefore)} -> ${fmtSize(e.sizeAfter)})${X}`); return; }
  process.stdout.write(render(a, b, { color }));
}
function show() {
  const s = openStore(true);
  const n = parseInt(words[1], 10);
  if (!n) { console.error('usage: agentspur show <step>'); process.exit(1); }
  const e = findEntry(s, n);
  if (!e.after) { console.error(`#${n} deleted ${e.path}; there is no "after". Try agentspur show ${n - 1} or agentspur diff ${n}.`); process.exit(1); }
  if (!s.hasObject(e.after)) { console.error('That file was too large to keep a copy of.'); process.exit(1); }
  process.stdout.write(s.readObject(e.after));
}

// ---------------------------------------------------------------- back
async function back() {
  const s = openStore(true);
  const target = words[1];
  if (!target) { console.error('usage: agentspur back <step>   or   agentspur back <HH:MM>'); process.exit(1); }
  const logAll = s.readLog();
  let n;
  if (/^\d{1,2}:\d{2}$/.test(target)) {
    const [h, m] = target.split(':').map(Number);
    const t = new Date(); t.setHours(h, m, 0, 0);
    const first = logAll.find(e => new Date(e.t) >= t && e.op !== 'start');
    if (!first) { console.log(`Nothing changed since ${target}. Nothing to do.`); return; }
    n = first.n;
  } else {
    n = parseInt(target, 10);
    if (!n) { console.error('agentspur: give a step number (see agentspur log) or a time like 14:02'); process.exit(1); }
  }
  const want = s.stateBefore(n);
  const have = s.readState();
  const plan = [];
  for (const [rel, w] of Object.entries(want)) {
    const h = have[rel];
    if (!h || h.hash !== w.hash) plan.push({ op: h ? 'restore' : 'recreate', path: rel, hash: w.hash });
  }
  for (const rel of Object.keys(have)) if (!want[rel]) plan.push({ op: 'remove', path: rel });
  plan.sort((a, b) => a.path.localeCompare(b.path));
  if (!plan.length) { console.log(`Everything is already as it was before step #${n}. Nothing to do.`); return; }
  const missing = plan.filter(p => p.hash && !s.hasObject(p.hash));
  console.log(`${B}Going back to before step #${n}${X} would:`);
  for (const p of plan) {
    const c = p.op === 'remove' ? R : p.op === 'recreate' ? G : Y;
    console.log(`  ${c}${p.op.padEnd(8)}${X} ${p.path}${p.hash && !s.hasObject(p.hash) ? `  ${D}(no copy kept, file too large: skipped)${X}` : ''}`);
  }
  if (missing.length) console.log(`${Y}${missing.length} file(s) cannot be restored because they were larger than ${fmtSize(MAX_OBJECT_BYTES)}.${X}`);
  if (!flags.has('--yes')) {
    const ok = await ask(`Do it? This is recorded too, so you can come back. [y/N] `);
    if (!ok) { console.log('Nothing changed.'); return; }
  }
  let done = 0;
  const touched = new Set();
  for (const p of plan) {
    const abs = path.join(s.root, p.path);
    try {
      if (p.op === 'remove') { fs.unlinkSync(abs); }
      else { if (!s.hasObject(p.hash)) continue; fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, s.readObject(p.hash)); }
      touched.add(p.path); done++;
    } catch (e) { console.error(`  could not ${p.op} ${p.path}: ${e.message}`); }
  }
  const entries = s.record(touched, 'restore');
  for (const e of entries) e.op = 'restore';
  // rewrite the ops we just appended as "restore" so the timeline says what happened
  if (entries.length) {
    const all = s.readLog();
    const ids = new Set(entries.map(e => e.n));
    const txt = all.map(e => JSON.stringify(ids.has(e.n) ? { ...e, op: 'restore' } : e)).join('\n') + '\n';
    fs.writeFileSync(s.logFile, txt);
  }
  console.log(`${G}Done.${X} ${done} file(s) returned to how they were before step #${n}.`);
  if (entries.length) console.log(`${D}Recorded as steps #${entries[0].n}–#${entries[entries.length - 1].n}. To undo the undo: agentspur back ${entries[0].n}${X}`);
}
function ask(q) {
  return new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, a => { rl.close(); res(/^y(es)?$/i.test(a.trim())); });
  });
}

// ---------------------------------------------------------------- status
function status() {
  const s = openStore(true);
  const log = s.readLog();
  const state = s.readState();
  let bytes = 0, count = 0;
  for (const f of fs.readdirSync(s.objects)) { try { bytes += fs.statSync(path.join(s.objects, f)).size; count++; } catch (_) {} }
  const changes = log.filter(e => e.op !== 'start');
  console.log(`${B}agentspur${X} in ${s.root}`);
  console.log(`  files watched:   ${Object.keys(state).length}`);
  console.log(`  steps recorded:  ${changes.length}${changes.length ? `  (first ${fmtDate(changes[0].t)} ${fmtTime(changes[0].t)}, last ${fmtDate(changes[changes.length - 1].t)} ${fmtTime(changes[changes.length - 1].t)})` : ''}`);
  console.log(`  copies kept:     ${count} (${fmtSize(bytes)}) in ${DIR}/objects`);
  let running = false;
  try { fs.statSync(s.lockFile); } catch (_) {}
  console.log(`  ${D}Is it watching right now? Look for a terminal running "agentspur watch". Delete ${DIR}/ to remove everything.${X}`);
  void running;
}

// ---------------------------------------------------------------- main
(async () => {
  try {
    switch (cmd) {
      case 'watch': return watch();
      case 'log': return log();
      case 'diff': return diff();
      case 'show': return show();
      case 'back': return await back();
      case 'status': return status();
      case '-v': case '--version': case 'version': return console.log(VERSION);
      default: return help();
    }
  } catch (e) {
    console.error('agentspur:', e.message);
    process.exit(1);
  }
})();
