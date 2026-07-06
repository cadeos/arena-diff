/**
 * Profile ArenaDiff vs baseline to locate bottlenecks.
 */

import { readFile } from 'node:fs/promises';
import { ArenaDiff, textToIds, StringInterner } from '../src/index.js';
import { baselineDiff } from './baseline.js';

const WORD_COUNT = 15000;

const VOCAB = [
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
  'shall', 'can', 'need', 'dare', 'ought', 'used', 'algorithm', 'memory', 'browser',
  'wasm', 'javascript', 'token', 'diff', 'linear', 'space', 'performance', 'optimize',
  'compare', 'sequence', 'matrix', 'crash', 'freeze', 'engine', 'wrapper', 'benchmark',
];
const PUNCT = ['.', ',', ';', ':', '!', '?', '—', '(', ')', '"', "'"];

function generateText(wordCount) {
  const parts = [];
  for (let i = 0; i < wordCount; i++) {
    parts.push(VOCAB[Math.floor(Math.random() * VOCAB.length)]);
    if (i > 0 && i % 17 === 0) parts.push(PUNCT[Math.floor(Math.random() * PUNCT.length)]);
    if (i < wordCount - 1) parts.push(' ');
  }
  return parts.join('');
}

function mutateText(baseText, mutationRate = 0.08) {
  const words = baseText.split(/(\s+|[.,;:!?—()"'])/).filter((s) => s.length > 0);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const roll = Math.random();
    if (roll < mutationRate * 0.4) {
      out.push(VOCAB[Math.floor(Math.random() * VOCAB.length)], ' ', words[i]);
    } else if (roll < mutationRate * 0.7) {
      continue;
    } else if (roll < mutationRate) {
      out.push(VOCAB[Math.floor(Math.random() * VOCAB.length)]);
    } else {
      out.push(words[i]);
    }
  }
  return out.join('');
}

function ms(t0) {
  return (performance.now() - t0).toFixed(1);
}

async function profileWasm(textA, textB) {
  const differ = new ArenaDiff();
  await differ.init();
  const { exports } = { exports: differ.exports };

  const timings = {};

  let t = performance.now();
  differ.interner.reset();
  const idsA = textToIds(textA, differ.interner);
  const idsB = textToIds(textB, differ.interner);
  timings.tokenize = ms(t);

  t = performance.now();
  exports.alloc_arena(idsA.length, idsB.length);
  const ptrA = exports.get_tokens_a_ptr() >>> 2;
  const ptrB = exports.get_tokens_b_ptr() >>> 2;
  const heap32 = new Int32Array(exports.memory.buffer);
  heap32.set(idsA, ptrA);
  heap32.set(idsB, ptrB);
  timings.copyToWasm = ms(t);

  t = performance.now();
  const resultLen = exports.run_diff();
  timings.run_diff_wasm = ms(t);

  t = performance.now();
  const mem = exports.memory.buffer;
  const opsView = new Int8Array(mem, exports.get_result_ops_ptr(), resultLen);
  const idxView = new Int32Array(mem, exports.get_result_indices_ptr(), resultLen);
  const ops = [];
  for (let r = 0; r < resultLen; r++) {
    const code = opsView[r];
    const index = idxView[r];
    if (code === 0) ops.push({ op: 'keep', token: differ.interner.lookup(idsA[index]) });
    else if (code === 1) ops.push({ op: 'insert', token: differ.interner.lookup(idsB[index]) });
    else ops.push({ op: 'delete', token: differ.interner.lookup(idsA[index]) });
  }
  timings.hydrateJsObjects = ms(t);

  timings.total = (
    parseFloat(timings.tokenize) +
    parseFloat(timings.copyToWasm) +
    parseFloat(timings.run_diff_wasm) +
    parseFloat(timings.hydrateJsObjects)
  ).toFixed(1);

  return { timings, resultLen, ops };
}

function profileBaseline(idsA, idsB, interner) {
  const timings = {};
  const n = idsA.length;
  const m = idsB.length;
  const idx = (i, j) => i * (m + 1) + j;

  let t = performance.now();
  const dp = new Int32Array((n + 1) * (m + 1));
  timings.allocMatrix = ms(t);

  t = performance.now();
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (idsA[i - 1] === idsB[j - 1]) {
        dp[idx(i, j)] = dp[idx(i - 1, j - 1)] + 1;
      } else {
        dp[idx(i, j)] = Math.max(dp[idx(i - 1, j)], dp[idx(i, j - 1)]);
      }
    }
  }
  timings.fillMatrix = ms(t);

  t = performance.now();
  const lcs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (idsA[i - 1] === idsB[j - 1]) {
      lcs.unshift(idsA[i - 1]);
      i--;
      j--;
    } else if (dp[idx(i - 1, j)] >= dp[idx(i, j - 1)]) {
      i--;
    } else {
      j--;
    }
  }
  timings.backtrackLcs = ms(t);

  t = performance.now();
  const result = baselineDiff(idsA, idsB, interner);
  timings.lcsToDiff = ms(t);

  timings.total = (
    parseFloat(timings.allocMatrix) +
    parseFloat(timings.fillMatrix) +
    parseFloat(timings.backtrackLcs) +
    parseFloat(timings.lcsToDiff)
  ).toFixed(1);

  return { timings, resultLen: result.ops.length };
}

async function countWasmCalls(textA, textB) {
  const differ = new ArenaDiff();
  await differ.init();

  let runDiffCalls = 0;
  const origRun = differ.exports.run_diff;
  differ.exports = {
    ...differ.exports,
    run_diff: () => {
      runDiffCalls++;
      return origRun();
    },
  };
  await differ.compare(textA, textB);

  return { runDiffCalls, note: 'Myers recursion happens inside this single run_diff() call' };
}

const textA = generateText(WORD_COUNT);
const textB = mutateText(textA);

console.log('Input tokens:', textToIds(textA, new StringInterner()).length, '/', textToIds(textB, new StringInterner()).length);
console.log('');

const wasm = await profileWasm(textA, textB);
console.log('=== ArenaDiff breakdown (ms) ===');
for (const [k, v] of Object.entries(wasm.timings)) {
  const pct = ((parseFloat(v) / parseFloat(wasm.timings.total)) * 100).toFixed(0);
  console.log(`  ${k.padEnd(20)} ${String(v).padStart(7)} ms  (${pct}%)`);
}
console.log(`  ops produced: ${wasm.resultLen}`);

const interner = new StringInterner();
const idsA = textToIds(textA, interner);
const idsB = textToIds(textB, interner);
const base = profileBaseline(idsA, idsB, interner);

console.log('');
console.log('=== Baseline breakdown (ms) ===');
for (const [k, v] of Object.entries(base.timings)) {
  const pct = ((parseFloat(v) / parseFloat(base.timings.total)) * 100).toFixed(0);
  console.log(`  ${k.padEnd(20)} ${String(v).padStart(7)} ms  (${pct}%)`);
}
console.log(`  ops produced: ${base.resultLen}`);

console.log('');
console.log('=== JS ↔ WASM boundary ===');
const calls = await countWasmCalls(textA, textB);
console.log(`  run_diff() invocations from Node: ${calls.runDiffCalls}`);
console.log(`  ${calls.note}`);

console.log('');
console.log('=== Theory check ===');
const n = idsA.length;
const m = idsB.length;
const baselineCells = n * m;
console.log(`  Baseline: 1 pass × ${n.toLocaleString()} × ${m.toLocaleString()} = ${baselineCells.toLocaleString()} cell updates`);
console.log(`  Myers: O((N+M)·D) where D = edit count — work scales with differences, not N×M.`);
