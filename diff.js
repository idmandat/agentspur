'use strict';
// agentspur – a small line diff (no dependencies). Good enough to see what an agent changed.
const LIMIT = 4000; // lines per side; beyond that we only report counts

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function lineDiff(aText, bText) {
  const a = aText.split('\n'), b = bText.split('\n');
  if (a.length > LIMIT || b.length > LIMIT) {
    return { tooBig: true, aLines: a.length, bLines: b.length, hunks: [] };
  }
  // LCS table
  const n = a.length, m = b.length;
  const dp = new Int32Array((n + 1) * (m + 1));
  const W = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = a[i] === b[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  // walk
  const ops = []; // [type, text] type: ' ', '-', '+'
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  // hunks with 3 lines of context
  const hunks = [];
  const C = 3;
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === ' ') { k++; continue; }
    const start = Math.max(0, k - C);
    let end = k;
    let last = k;
    while (end < ops.length) {
      if (ops[end][0] !== ' ') last = end;
      else if (end - last > 2 * C) break;
      end++;
    }
    end = Math.min(ops.length, last + C + 1);
    hunks.push(ops.slice(start, end));
    k = end;
  }
  let added = 0, removed = 0;
  for (const [t] of ops) { if (t === '+') added++; else if (t === '-') removed++; }
  return { tooBig: false, added, removed, hunks };
}

function render(aBuf, bBuf, opts = {}) {
  const color = opts.color !== false;
  const R = color ? '\x1b[31m' : '', G = color ? '\x1b[32m' : '', D = color ? '\x1b[2m' : '', X = color ? '\x1b[0m' : '';
  if ((aBuf && isBinary(aBuf)) || (bBuf && isBinary(bBuf))) {
    return `  binary file: ${aBuf ? aBuf.length : 0} -> ${bBuf ? bBuf.length : 0} bytes\n`;
  }
  const d = lineDiff(aBuf ? aBuf.toString('utf8') : '', bBuf ? bBuf.toString('utf8') : '');
  if (d.tooBig) return `  too large for a line diff (${d.aLines} -> ${d.bLines} lines)\n`;
  let out = `  ${G}+${d.added}${X} ${R}-${d.removed}${X}\n`;
  for (const h of d.hunks) {
    out += `  ${D}...${X}\n`;
    for (const [t, text] of h) {
      const c = t === '+' ? G : t === '-' ? R : D;
      out += `  ${c}${t} ${text}${X}\n`;
    }
  }
  return out;
}

module.exports = { render, lineDiff, isBinary };
