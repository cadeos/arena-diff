/**
 * Diagnostic: locate ArenaDiff bottlenecks vs @fishan/myers-core-diff (time)
 * and vs diff-native (memory). Run with: node --expose-gc diagnose.js
 */

import diffNative from 'diff-native';
import { createRequire } from 'node:module';
import { MyersCoreDiff } from '@fishan/myers-core-diff';

const require = createRequire(import.meta.url);
const dnPath = require.resolve('diff-native');
const diffNativeInternal = require(dnPath.replace(/index\.js$/, 'diff_native.js'));
import { ArenaDiff, textToIds, StringInterner, tokenize, applyDiff } from '../src/index.js';

const WORD_COUNT = 15000;
const MUTATION_RATE = 0.08;
const RUNS = 5;

const VOCAB = [
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
  'shall', 'can', 'need', 'dare', 'ought', 'used', 'algorithm', 'memory', 'browser',
  'wasm', 'javascript', 'token', 'diff', 'linear', 'space', 'performance', 'optimize',
  'compare', 'sequence', 'matrix', 'crash', 'freeze', 'engine', 'wrapper', 'benchmark',
];
const PUNCT = ['.', ',', ';', ':', '!', '?', '—', '(', ')', '"', "'"];
const ri = (n) => Math.floor(Math.random() * n);

function generateText(w) {
  const p = [];
  for (let i = 0; i < w; i++) {
    p.push(VOCAB[ri(VOCAB.length)]);
    if (i > 0 && i % 17 === 0) p.push(PUNCT[ri(PUNCT.length)]);
    if (i < w - 1) p.push(' ');
  }
  return p.join('');
}
function mutateText(t, rate) {
  const w = t.split(/(\s+|[.,;:!?—()"'])/).filter((s) => s.length);
  const o = [];
  for (const x of w) {
    const r = Math.random();
    if (r < rate * 0.4) o.push(VOCAB[ri(VOCAB.length)], ' ', x);
    else if (r < rate * 0.7) continue;
    else if (r < rate) o.push(VOCAB[ri(VOCAB.length)]);
    else o.push(x);
  }
  return o.join('');
}

const gc = () => globalThis.gc && globalThis.gc();
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const kb = (b) => `${(b / 1024).toFixed(0)} KiB`;
const mib = (b) => `${(b / (1024 * 1024)).toFixed(2)} MiB`;

function time(fn, runs = RUNS) {
  for (let i = 0; i < 2; i++) fn();
  const t = [];
  for (let i = 0; i < runs; i++) {
    gc();
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  return med(t);
}
async function timeAsync(fn, runs = RUNS) {
  for (let i = 0; i < 2; i++) await fn();
  const t = [];
  for (let i = 0; i < runs; i++) {
    gc();
    const s = performance.now();
    await fn();
    t.push(performance.now() - s);
  }
  return med(t);
}
function heapDelta(fn) {
  gc();
  const b = process.memoryUsage().heapUsed;
  const r = fn();
  gc();
  return { r, d: Math.max(0, process.memoryUsage().heapUsed - b) };
}

const textA = generateText(WORD_COUNT);
const textB = mutateText(textA, MUTATION_RATE);
const tokensA = tokenize(textA);
const tokensB = tokenize(textB);
const interner = new StringInterner();
const idsA = textToIds(textA, interner);
const idsB = textToIds(textB, interner);

const differ = new ArenaDiff();
await differ.init();
const myersCore = new MyersCoreDiff();

console.log('\n' + '='.repeat(78));
console.log('  PART 1 — TIME: why ArenaDiff (whole pipeline) is slower than myers-core');
console.log('='.repeat(78));
console.log(`  Tokens: A=${tokensA.length}  B=${tokensB.length}  edits≈7.3k\n`);

// --- ArenaDiff.compare full pipeline broken into phases ---
const ex = differ.exports;
const phase = {};

phase.tokenize_intern = time(() => {
  differ.interner.reset();
  const a = textToIds(textA, differ.interner);
  const b = textToIds(textB, differ.interner);
  return a.length + b.length;
});

// prepare ids once for isolated phases
differ.interner.reset();
const wIdsA = textToIds(textA, differ.interner);
const wIdsB = textToIds(textB, differ.interner);

phase.alloc_and_copy = time(() => {
  ex.alloc_arena(wIdsA.length, wIdsB.length);
  const pa = ex.get_tokens_a_ptr() >>> 2;
  const pb = ex.get_tokens_b_ptr() >>> 2;
  const h = new Int32Array(ex.memory.buffer);
  h.set(wIdsA, pa);
  h.set(wIdsB, pb);
});

// keep arena populated for run_diff timing
ex.alloc_arena(wIdsA.length, wIdsB.length);
{
  const h = new Int32Array(ex.memory.buffer);
  h.set(wIdsA, ex.get_tokens_a_ptr() >>> 2);
  h.set(wIdsB, ex.get_tokens_b_ptr() >>> 2);
}
phase.run_diff_C = time(() => ex.run_diff());

const resultLen = ex.run_diff();
phase.hydrate_JS_objects = time(() => {
  const mem = ex.memory.buffer;
  const opsView = new Int8Array(mem, ex.get_result_ops_ptr(), resultLen);
  const idxView = new Int32Array(mem, ex.get_result_indices_ptr(), resultLen);
  const ops = [];
  for (let r = 0; r < resultLen; r++) {
    const c = opsView[r];
    const ix = idxView[r];
    if (c === 0) ops.push({ op: 'keep', token: differ.interner.lookup(wIdsA[ix]) });
    else if (c === 1) ops.push({ op: 'insert', token: differ.interner.lookup(wIdsB[ix]) });
    else ops.push({ op: 'delete', token: differ.interner.lookup(wIdsA[ix]) });
  }
  return ops.length;
});

const wasmFull = await timeAsync(() => differ.compare(textA, textB));

console.log('  ArenaDiff.compare() phase breakdown:');
const wtotal = phase.tokenize_intern + phase.alloc_and_copy + phase.run_diff_C + phase.hydrate_JS_objects;
for (const [k, v] of Object.entries(phase)) {
  console.log(`    ${k.padEnd(22)} ${v.toFixed(1).padStart(7)} ms  (${((v / wtotal) * 100).toFixed(0)}%)`);
}
console.log(`    ${'—'.repeat(40)}`);
console.log(`    ${'sum of phases'.padEnd(22)} ${wtotal.toFixed(1).padStart(7)} ms`);
console.log(`    ${'compare() measured'.padEnd(22)} ${wasmFull.toFixed(1).padStart(7)} ms\n`);

// --- myers-core: what is actually timed in the benchmark vs full pipeline ---
const mcCoreOnly = time(() => myersCore.diff(tokensA, tokensB)); // tokens precomputed (benchmark scope)
const mcWithTokenize = time(() => {
  const ta = tokenize(textA);
  const tb = tokenize(textB);
  return myersCore.diff(ta, tb);
});

console.log('  @fishan/myers-core-diff:');
console.log(`    diff(tokens) only        ${mcCoreOnly.toFixed(1).padStart(7)} ms   <- what the benchmark timed`);
console.log(`    tokenize + diff          ${mcWithTokenize.toFixed(1).padStart(7)} ms   <- comparable to compare()\n`);

console.log('  APPLES-TO-APPLES (core diff math only, tokens already interned):');
console.log(`    ArenaDiff  run_diff (C)   ${phase.run_diff_C.toFixed(1).padStart(7)} ms`);
console.log(`    myers-core diff (JS)     ${mcCoreOnly.toFixed(1).padStart(7)} ms`);
console.log(`    ratio                    ${(phase.run_diff_C / mcCoreOnly).toFixed(1)}× (ArenaDiff slower on core math)\n`);

console.log('='.repeat(78));
console.log('  PART 2 — MEMORY: ArenaDiff arena vs diff-native true WASM memory');
console.log('='.repeat(78) + '\n');

// ArenaDiff arena exact size
const arenaBytes = differ.lastArenaBytes;

// diff-native TRUE wasm linear memory growth (heap-delta misses this entirely)
const dnWasm = diffNativeInternal.__wasm;
gc();
const dnPagesBefore = dnWasm.memory.buffer.byteLength;
const dnHeap = heapDelta(() => diffNative.diffWords(textA, textB));
const dnPagesAfter = dnWasm.memory.buffer.byteLength;
const dnWasmGrowth = dnPagesAfter - dnPagesBefore;

// myers-core heap delta (the missing metric)
const mcHeap = heapDelta(() => myersCore.diff(tokensA, tokensB));

console.log('  ArenaDiff (exact arena, in WASM linear memory):');
console.log(`    arena total              ${mib(arenaBytes)}`);
const n = wIdsA.length;
const m = wIdsB.length;
const minNM = Math.min(n, m);
const parts = {
  'tokens_a + tokens_b': (n + m) * 4,
  'result_ops': (n + m) * 1,
  'result_indices': (n + m) * 4,
  'edit_ops': (n + m) * 4,
  'edit_idx': (n + m) * 4,
  'v_fwd': (2 * minNM + 2) * 4,
  'v_bwd': (2 * minNM + 2) * 4,
};
for (const [k, v] of Object.entries(parts)) {
  console.log(`      ${k.padEnd(22)} ${kb(v).padStart(9)}  (${((v / arenaBytes) * 100).toFixed(0)}%)`);
}

console.log('\n  diff-native (Rust/WASM):');
console.log(`    JS heap delta            ${kb(dnHeap.d).padStart(9)}   <- what the benchmark reported`);
console.log(`    WASM linear mem growth   ${kb(dnWasmGrowth).padStart(9)}   <- was INVISIBLE to heap-delta`);
console.log(`    total wasm pages now     ${mib(dnPagesAfter)}`);

console.log('\n  @fishan/myers-core-diff:');
console.log(`    JS heap delta            ${kb(mcHeap.d).padStart(9)}   <- the previously missing metric\n`);

console.log('  KEY POINT: diff-native memory was undercounted — heap-delta cannot see');
console.log('  bytes that live in the WASM linear memory. Same reason ArenaDiff shows as');
console.log('  "more memory": we report the EXACT arena, they reported only JS-side heap.\n');
