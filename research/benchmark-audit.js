/**
 * Critical audit: fair vs unfair timing scopes for cross-library comparison.
 * Run: node --expose-gc benchmark-audit.js
 */

import { ArenaDiff, textToIds, tokenize, StringInterner } from '../src/index.js';
import { MyersCoreDiff } from '@fishan/myers-core-diff';
import { diff as fastMyersDiff } from 'fast-myers-diff';

const WORD_COUNT = 15000;
const MUTATION_RATE = 0.08;
const RUNS = 10;

const VOCAB = [
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
  'shall', 'can', 'need', 'dare', 'ought', 'used', 'algorithm', 'memory', 'browser',
  'wasm', 'javascript', 'token', 'diff', 'linear', 'space', 'performance', 'optimize',
  'compare', 'sequence', 'matrix', 'crash', 'freeze', 'engine', 'wrapper', 'benchmark',
];
const PUNCT = ['.', ',', ';', ':', '!', '?', '—', '(', ')', '"', "'"];

function ri(n) {
  return Math.floor(Math.random() * n);
}

function generateText(wordCount) {
  const parts = [];
  for (let i = 0; i < wordCount; i++) {
    parts.push(VOCAB[ri(VOCAB.length)]);
    if (i > 0 && i % 17 === 0) parts.push(PUNCT[ri(PUNCT.length)]);
    if (i < wordCount - 1) parts.push(' ');
  }
  return parts.join('');
}

function mutateText(baseText, mutationRate) {
  const words = baseText.split(/(\s+|[.,;:!?—()"'])/).filter((s) => s.length > 0);
  const out = [];
  for (const x of words) {
    const roll = Math.random();
    if (roll < mutationRate * 0.4) out.push(VOCAB[ri(VOCAB.length)], ' ', x);
    else if (roll < mutationRate * 0.7) continue;
    else if (roll < mutationRate) out.push(VOCAB[ri(VOCAB.length)]);
    else out.push(x);
  }
  return out.join('');
}

const gc = () => globalThis.gc && globalThis.gc();
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

async function benchAsync(label, fn) {
  for (let w = 0; w < 2; w++) await fn();
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    gc();
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  return { label, ms: med(times) };
}

function benchSync(label, fn) {
  for (let w = 0; w < 2; w++) fn();
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    gc();
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return { label, ms: med(times) };
}

const textA = generateText(WORD_COUNT);
const textB = mutateText(textA, MUTATION_RATE);
const tokensA = tokenize(textA);
const tokensB = tokenize(textB);

const differ = new ArenaDiff();
await differ.init();
const ex = differ.exports;
const mc = new MyersCoreDiff();

console.log('\n' + '═'.repeat(72));
console.log('  BENCHMARK AUDIT — timing scope fairness');
console.log('═'.repeat(72));
console.log(`  Tokens: A=${tokensA.length.toLocaleString()}  B=${tokensB.length.toLocaleString()}`);
console.log(`  Median of ${RUNS} runs after 2 warmup (with --expose-gc)\n`);

const results = [];

// Scenario A: what benchmark-compare.js actually measures
results.push(await benchAsync('A1 ArenaDiff compare(textA,textB) [FULL]', () => differ.compare(textA, textB)));
results.push(benchSync('A2 myers-core diff(tokensA,tokensB) [DIFF ONLY]', () => mc.diff(tokensA, tokensB)));
results.push(benchSync('A3 fast-myers diff(tokens) [DIFF ONLY]', () => {
  for (const _ of fastMyersDiff(tokensA, tokensB)) {
    /* drain */
  }
}));

// Scenario B: fair end-to-end (tokenize inside timer)
results.push(benchSync('B1 myers-core tokenize+diff [FAIR E2E]', () => {
  const ta = tokenize(textA);
  const tb = tokenize(textB);
  return mc.diff(ta, tb);
}));
results.push(benchSync('B2 fast-myers tokenize+diff [FAIR E2E]', () => {
  const ta = tokenize(textA);
  const tb = tokenize(textB);
  for (const _ of fastMyersDiff(ta, tb)) {
    /* drain */
  }
}));

// Scenario C: core engine only (pre-tokenized integers)
differ.interner.reset();
const wIdsA = textToIds(textA, differ.interner);
const wIdsB = textToIds(textB, differ.interner);
ex.alloc_arena(wIdsA.length, wIdsB.length);
{
  const h = new Int32Array(ex.memory.buffer);
  h.set(wIdsA, ex.get_tokens_a_ptr() >>> 2);
  h.set(wIdsB, ex.get_tokens_b_ptr() >>> 2);
}
results.push(benchSync('C1 ArenaDiff run_diff() only [CORE]', () => ex.run_diff()));
results.push(benchSync('C2 myers-core diff(tokens) [CORE on strings]', () => mc.diff(tokensA, tokensB)));

// Scenario D: ArenaDiff without hydrate (tokenize + C + counts only)
results.push(benchSync('D1 ArenaDiff tokenize+run_diff [no hydrate]', () => {
  differ.interner.reset();
  const a = textToIds(textA, differ.interner);
  const b = textToIds(textB, differ.interner);
  ex.alloc_arena(a.length, b.length);
  const h = new Int32Array(ex.memory.buffer);
  h.set(a, ex.get_tokens_a_ptr() >>> 2);
  h.set(b, ex.get_tokens_b_ptr() >>> 2);
  return ex.run_diff();
}));

console.log('  TIMING SCOPES');
console.log('  ' + '─'.repeat(68));
for (const r of results) {
  console.log(`  ${r.label.padEnd(48)} ${r.ms.toFixed(1).padStart(7)} ms`);
}

const a1 = results.find((r) => r.label.startsWith('A1')).ms;
const a2 = results.find((r) => r.label.startsWith('A2')).ms;
const b1 = results.find((r) => r.label.startsWith('B1')).ms;
const c1 = results.find((r) => r.label.startsWith('C1')).ms;
const c2 = results.find((r) => r.label.startsWith('C2')).ms;

console.log('\n  VERDICT');
console.log('  ' + '─'.repeat(68));
console.log(`  Current benchmark (A1 vs A2): ArenaDiff ${a1.toFixed(1)} ms vs myers-core ${a2.toFixed(1)} ms`);
console.log(`    → myers-core EXCLUDES tokenization (~${(b1 - a2).toFixed(1)} ms saved)`);
console.log(`  Fair E2E (A1 vs B1):           ArenaDiff ${a1.toFixed(1)} ms vs myers-core ${b1.toFixed(1)} ms`);
console.log(`  Core engine only (C1 vs C2):   ArenaDiff C ${c1.toFixed(1)} ms vs myers-core ${c2.toFixed(1)} ms`);
console.log('');
if (a1 < b1) {
  console.log('  ✓ ArenaDiff still wins on FAIR end-to-end comparison');
} else {
  console.log('  ✗ ArenaDiff LOSES on fair end-to-end — headline was misleading');
}
if (c1 < c2) {
  console.log('  ✓ ArenaDiff C engine is genuinely faster on core diff math');
} else {
  console.log('  ✗ ArenaDiff C engine is NOT faster — pipeline overhead hid the truth');
}
console.log('');
