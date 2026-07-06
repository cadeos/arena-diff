/**
 * Large-book benchmark — arena-diff vs myers-core-diff (E2E).
 *
 * Usage: node --expose-gc research/big-book-benchmark.js
 */

import { performance } from 'node:perf_hooks';
import { MyersCoreDiff } from '@fishan/myers-core-diff';
import { ArenaDiff, tokenize, applyDiff } from '../src/index.js';
import { generateText, mutateText } from './benchmark-data.js';

const RUNS = 7;
const WARMUP = 2;

function gc() {
  if (globalThis.gc) globalThis.gc();
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function fmtMs(ms) {
  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

async function benchArena(textA, textB, runs = RUNS) {
  gc();
  const differ = new ArenaDiff();
  await differ.init();
  for (let i = 0; i < WARMUP; i++) await differ.compare(textA, textB);
  const times = [];
  let result;
  for (let i = 0; i < runs; i++) {
    gc();
    const t0 = performance.now();
    result = await differ.compare(textA, textB);
    times.push(performance.now() - t0);
  }
  const ok = applyDiff(tokenize(textA), result) === tokenize(textB).join('');
  return { ms: median(times), ok };
}

function benchMyers(textA, textB, runs = RUNS) {
  gc();
  const mc = new MyersCoreDiff();
  for (let i = 0; i < WARMUP; i++) {
    mc.diff(tokenize(textA), tokenize(textB));
  }
  const times = [];
  for (let i = 0; i < runs; i++) {
    gc();
    const t0 = performance.now();
    mc.diff(tokenize(textA), tokenize(textB));
    times.push(performance.now() - t0);
  }
  return { ms: median(times) };
}

const scenarios = [
  { label: 'Novella ~40k', words: 40000 },
  { label: 'Novel ~80k', words: 80000 },
  { label: 'Long novel ~100k', words: 100000 },
  { label: 'Long novel ~120k', words: 120000 },
  { label: 'Epic ~200k', words: 200000 },
  { label: 'Omnibus ~250k', words: 250000, runs: 3 },
  { label: 'Omnibus ~300k', words: 300000, runs: 3 },
];

console.log('\nLarge-book benchmark — ~5% revision, E2E, median of', RUNS, 'runs\n');
console.log(
  'Scenario'.padEnd(22),
  'arena-diff'.padStart(10),
  'myers-core'.padStart(11),
  'ratio'.padStart(8),
  'OK'.padStart(5),
);
console.log('─'.repeat(60));

for (const s of scenarios) {
  const runs = s.runs ?? RUNS;
  const textA = generateText(s.words, 42);
  const textB = mutateText(textA, 0.05, 42);
  const a = await benchArena(textA, textB, runs);
  const m = benchMyers(textA, textB, runs);
  const ratio = m.ms / a.ms;
  const ratioStr = ratio >= 1 ? `arena ${ratio.toFixed(1)}×` : `mc ${(a.ms / m.ms).toFixed(1)}×`;
  console.log(
    s.label.padEnd(22),
    fmtMs(a.ms).padStart(10),
    fmtMs(m.ms).padStart(11),
    ratioStr.padStart(8),
    (a.ok ? 'PASS' : 'FAIL').padStart(5),
  );
}
console.log('');
