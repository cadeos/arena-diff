/**
 * Cross-library benchmark — similar/dissimilar scenarios up to 30k words.
 *
 * Usage:  node --expose-gc benchmark-compare.js
 *         node --expose-gc benchmark-compare.js --quick   # 15k only
 *         node --expose-gc benchmark-compare.js --scenario sim-30k-8
 */

import diffNative from 'diff-native';
import { createRequire } from 'node:module';
import { MyersCoreDiff } from '@fishan/myers-core-diff';
import { diff as fastMyersDiff } from 'fast-myers-diff';
import { diff as dmpDiff } from 'diff-match-patch-es';
import { diffWords as jsdiffWords, diffLines as jsdiffLines } from 'diff';
import { ArenaDiff, textToIds, StringInterner, tokenize, applyDiff } from '../src/index.js';
import { baselineDiff } from './baseline.js';
import {
  SCENARIOS,
  buildScenarioInputs,
  countWords,
  shouldRunBaseline,
} from './benchmark-data.js';

const require = createRequire(import.meta.url);
const diffSequenceModule = require('diff-sequences');
const diffSequence = diffSequenceModule.default ?? diffSequenceModule;
const fastDiff = require('fast-diff');

let diffNativeWasm = null;
try {
  const dnPath = require.resolve('diff-native');
  diffNativeWasm = require(dnPath.replace(/index\.js$/, 'diff_native.js')).__wasm;
} catch {
  /* fall back to heap delta only */
}

const WARMUP = 0;
const RUNS = 1;
const SEED = 42;
const LIB_TIMEOUT_MS = 60_000;

const args = process.argv.slice(2);
const quickMode = args.includes('--quick');
const scenarioFilter = args.find((a) => a.startsWith('--scenario='))?.split('=')[1]
  ?? (args.includes('--scenario') ? args[args.indexOf('--scenario') + 1] : null);

function gc() {
  if (globalThis.gc) globalThis.gc();
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function formatTime(ms) {
  if (ms == null) return '—';
  if (ms === Infinity) return '>60s';
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatBytes(bytes) {
  if (bytes == null || bytes < 0) return 'n/a';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
}

function pad(str, w, right = false) {
  const s = String(str);
  if (s.length >= w) return s.slice(0, w);
  return right ? ' '.repeat(w - s.length) + s : s + ' '.repeat(w - s.length);
}

function bench(fn, { warmup = WARMUP, runs = RUNS } = {}) {
  const deadline = performance.now() + LIB_TIMEOUT_MS;
  for (let i = 0; i < warmup; i++) {
    if (performance.now() > deadline) return { ms: Infinity, timedOut: true };
    fn();
  }
  const times = [];
  let last;
  for (let i = 0; i < runs; i++) {
    if (performance.now() > deadline) return { ms: Infinity, timedOut: true };
    gc();
    const t0 = performance.now();
    last = fn();
    times.push(performance.now() - t0);
  }
  return { ms: median(times), result: last };
}

async function benchAsync(fn, { warmup = WARMUP, runs = RUNS } = {}) {
  const deadline = performance.now() + LIB_TIMEOUT_MS;
  for (let i = 0; i < warmup; i++) {
    if (performance.now() > deadline) return { ms: Infinity, timedOut: true };
    await fn();
  }
  const times = [];
  let last;
  for (let i = 0; i < runs; i++) {
    if (performance.now() > deadline) return { ms: Infinity, timedOut: true };
    gc();
    const t0 = performance.now();
    last = await fn();
    times.push(performance.now() - t0);
  }
  return { ms: median(times), result: last };
}

/** Skip libs that consistently exceed 60s on these inputs. */
function shouldSkipLib(libId, scenario) {
  const heavyChar =
    libId === 'fast-diff' || libId === 'dmp'
      ? scenario.kind === 'dissimilar'
        || scenario.words >= 30000
        || ((scenario.rate ?? 0) >= 0.5 && scenario.words >= 15000)
      : false;

  const diffNativeCrash =
    libId === 'diff-native' && scenario.words >= 30000 && (scenario.rate ?? 0) >= 0.5;

  const jsdiffWordsSlow =
    libId === 'jsdiff-words'
      && (scenario.words >= 30000 || (scenario.rate ?? 0) >= 0.5);

  return heavyChar || diffNativeCrash || jsdiffWordsSlow;
}

function measureHeap(fn) {
  gc();
  const before = process.memoryUsage().heapUsed;
  const result = fn();
  gc();
  return { result, heapDelta: Math.max(0, process.memoryUsage().heapUsed - before) };
}

function measureWasmMemory(fn, wasmExports) {
  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const wasmBefore = wasmExports ? wasmExports.memory.buffer.byteLength : 0;
  const result = fn();
  const wasmAfter = wasmExports ? wasmExports.memory.buffer.byteLength : 0;
  gc();
  const heapDelta = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
  const wasmGrowth = Math.max(0, wasmAfter - wasmBefore);
  return { result, total: heapDelta + wasmGrowth };
}

function rebuildMyersCore(tokensA, result) {
  const out = [];
  let ti = 0;
  for (const [op, tok] of result) {
    if (op === 0) out.push(tokensA[ti++]);
    else if (op === 2) ti++;
    else out.push(tok);
  }
  return out.join('');
}

/**
 * Algorithm families represented in this benchmark (2015–2025 landscape).
 * Patience / Histogram (Git 2010–2018) have no mature standalone npm port;
 * myers-core and ArenaDiff embed anchor/heuristic strategies inspired by them.
 */
const LIBRARY_CATALOG = [
  {
    id: 'arena-diff',
    name: 'ArenaDiff',
    algorithm: 'Myers+anchor+guided',
    backend: 'C/WASM',
    granularity: 'token',
    since: '2025',
  },
  {
    id: 'baseline',
    name: 'Baseline matrix',
    algorithm: 'LCS DP O(NM)',
    backend: 'JS',
    granularity: 'token',
    since: 'ref',
  },
  {
    id: 'myers-core',
    name: 'myers-core-diff',
    algorithm: 'Myers+anchor+guided',
    backend: 'JS',
    granularity: 'token',
    since: '2024',
  },
  {
    id: 'fast-myers',
    name: 'fast-myers-diff',
    algorithm: 'Myers stream',
    backend: 'JS',
    granularity: 'token',
    since: '2019',
  },
  {
    id: 'diff-sequences',
    name: 'diff-sequences',
    algorithm: 'Myers linear LCS',
    backend: 'JS (Jest)',
    granularity: 'token',
    since: '2018',
  },
  {
    id: 'diff-native',
    name: 'diff-native',
    algorithm: 'Myers (Rust)',
    backend: 'Rust/WASM',
    granularity: 'word',
    since: '2023',
  },
  {
    id: 'jsdiff-words',
    name: 'jsdiff (words)',
    algorithm: 'Myers',
    backend: 'JS',
    granularity: 'word',
    since: '2014',
  },
  {
    id: 'jsdiff-lines',
    name: 'jsdiff (lines)',
    algorithm: 'Myers',
    backend: 'JS',
    granularity: 'line',
    since: '2014',
  },
  {
    id: 'fast-diff',
    name: 'fast-diff',
    algorithm: 'DMP char',
    backend: 'JS',
    granularity: 'char',
    since: '2014',
  },
  {
    id: 'dmp',
    name: 'diff-match-patch-es',
    algorithm: 'Myers char',
    backend: 'JS',
    granularity: 'char',
    since: '2015',
  },
];

async function runLibrary(libId, ctx, scenario) {
  if (shouldSkipLib(libId, scenario)) {
    return { ms: null, memory: null, memoryNote: '>60s est', ok: 'SKIP' };
  }

  const {
    textA,
    textB,
    tokensA,
    tokensB,
    idsA,
    idsB,
    interner,
    wasmDiffer,
    myersCore,
    dnWasmBaseline,
    baselineMatrixBytes,
    runBaseline,
  } = ctx;

  switch (libId) {
    case 'arena-diff': {
      const { ms, result, timedOut } = await benchAsync(() => wasmDiffer.compare(textA, textB));
      if (timedOut) return { ms: Infinity, memory: null, memoryNote: 'arena', ok: 'TIMEOUT' };
      const ok = applyDiff(tokensA, result) === tokensB.join('');
      return {
        ms,
        memory: wasmDiffer.lastArenaBytes,
        memoryNote: 'arena',
        ok: ok ? 'PASS' : 'FAIL',
      };
    }
    case 'baseline': {
      if (!runBaseline) {
        return { ms: null, memory: baselineMatrixBytes, memoryNote: 'DP skip', ok: 'SKIP' };
      }
      const { ms, result, timedOut } = bench(() => baselineDiff(idsA, idsB, interner));
      if (timedOut) return { ms: Infinity, memory: baselineMatrixBytes, memoryNote: 'DP matrix', ok: 'TIMEOUT' };
      const ok = applyDiff(tokensA, result) === tokensB.join('');
      return {
        ms,
        memory: baselineMatrixBytes,
        memoryNote: 'DP matrix',
        ok: ok ? 'PASS' : 'FAIL',
      };
    }
    case 'myers-core': {
      const { ms, result } = bench(() => {
        const ta = tokenize(textA);
        const tb = tokenize(textB);
        return myersCore.diff(ta, tb);
      });
      const ok = rebuildMyersCore(tokensA, result) === tokensB.join('');
      const { total } = measureWasmMemory(() => {
        const ta = tokenize(textA);
        const tb = tokenize(textB);
        return myersCore.diff(ta, tb);
      }, null);
      return { ms, memory: total, memoryNote: 'heap Δ', ok: ok ? 'PASS' : 'FAIL' };
    }
    case 'fast-myers': {
      const { ms } = bench(() => {
        for (const _ of fastMyersDiff(tokensA, tokensB)) {
          /* drain */
        }
      });
      const { total } = measureWasmMemory(() => {
        for (const _ of fastMyersDiff(tokensA, tokensB)) {
          /* drain */
        }
      }, null);
      return { ms, memory: total, memoryNote: 'heap Δ', ok: '—' };
    }
    case 'diff-sequences': {
      const { ms } = bench(() => {
        diffSequence(
          tokensA.length,
          tokensB.length,
          (i, j) => tokensA[i] === tokensB[j],
          () => {},
        );
      });
      const { heapDelta } = measureHeap(() => {
        diffSequence(
          tokensA.length,
          tokensB.length,
          (i, j) => tokensA[i] === tokensB[j],
          () => {},
        );
      });
      return { ms, memory: heapDelta, memoryNote: 'heap Δ', ok: '—' };
    }
    case 'diff-native': {
      const { ms } = bench(() => diffNative.diffWords(textA, textB));
      const { heapDelta } = measureHeap(() => diffNative.diffWords(textA, textB));
      const dnWasmResident = diffNativeWasm
        ? Math.max(0, diffNativeWasm.memory.buffer.byteLength - dnWasmBaseline)
        : 0;
      return {
        ms,
        memory: heapDelta + dnWasmResident,
        memoryNote: diffNativeWasm ? 'heap+wasm' : 'heap Δ',
        ok: '—',
      };
    }
    case 'jsdiff-words': {
      const { ms } = bench(() => jsdiffWords(textA, textB));
      const { heapDelta } = measureHeap(() => jsdiffWords(textA, textB));
      return { ms, memory: heapDelta, memoryNote: 'heap Δ', ok: '—' };
    }
    case 'jsdiff-lines': {
      const { ms } = bench(() => jsdiffLines(textA, textB));
      const { heapDelta } = measureHeap(() => jsdiffLines(textA, textB));
      return { ms, memory: heapDelta, memoryNote: 'heap Δ', ok: '—' };
    }
    case 'fast-diff': {
      const { ms, timedOut } = bench(() => fastDiff(textA, textB));
      if (timedOut) return { ms: Infinity, memory: null, memoryNote: 'heap Δ', ok: 'TIMEOUT' };
      const { heapDelta } = measureHeap(() => fastDiff(textA, textB));
      return { ms, memory: heapDelta, memoryNote: 'heap Δ', ok: '—' };
    }
    case 'dmp': {
      try {
        const { ms, timedOut } = bench(() => dmpDiff(textA, textB, { diffTimeout: 55 }));
        if (timedOut) return { ms: Infinity, memory: null, memoryNote: 'heap Δ', ok: 'TIMEOUT' };
        const { heapDelta } = measureHeap(() => dmpDiff(textA, textB, { diffTimeout: 55 }));
        return { ms, memory: heapDelta, memoryNote: 'heap Δ', ok: '—' };
      } catch {
        return { ms: Infinity, memory: null, memoryNote: 'heap Δ', ok: 'TIMEOUT' };
      }
    }
    default:
      return { ms: null, memory: null, memoryNote: '—', ok: '—' };
  }
}

function printScenarioTable(scenario, input, results) {
  const wasmMs = results.find((r) => r.id === 'arena-diff')?.ms;

  console.log('');
  console.log('─'.repeat(110));
  console.log(`  ${scenario.label}  (${scenario.id})`);
  console.log('─'.repeat(110));
  console.log(
    `  A: ${input.wordsA.toLocaleString()} words · ${input.tokensA.toLocaleString()} tokens · ${input.charsA.toLocaleString()} chars`,
  );
  console.log(
    `  B: ${input.wordsB.toLocaleString()} words · ${input.tokensB.toLocaleString()} tokens · ${input.charsB.toLocaleString()} chars`,
  );
  console.log(`  Kind: ${scenario.kind}${scenario.rate != null ? ` · mutation ~${(scenario.rate * 100).toFixed(0)}%` : ''}`);
  console.log('');

  const hdr =
    pad('Library', 22) +
    pad('Algorithm', 22) +
    pad('Granularity', 10) +
    pad('Time', 10) +
    pad('× ArenaDiff', 11) +
    pad('Memory', 12) +
    pad('OK', 8);
  console.log(hdr);
  console.log('─'.repeat(110));

  for (const meta of LIBRARY_CATALOG) {
    const r = results.find((x) => x.id === meta.id);
    if (!r) continue;

    const vs =
      typeof r.ms === 'number' && r.ms > 0 && typeof wasmMs === 'number' && wasmMs > 0
        ? meta.id === 'arena-diff'
          ? '1.0×'
          : `${(r.ms / wasmMs).toFixed(1)}×`
        : '—';

    const mem =
      r.memoryNote === 'DP matrix' || r.memoryNote === 'arena'
        ? formatBytes(r.memory)
        : r.memory != null
          ? `~${formatBytes(r.memory)}`
          : 'n/a';

    console.log(
      pad(meta.name, 22) +
        pad(meta.algorithm, 22) +
        pad(meta.granularity, 10) +
        pad(formatTime(r.ms), 10) +
        pad(vs, 11) +
        pad(mem, 12) +
        pad(r.ok, 8),
    );
  }

  const timed = results.filter((r) => typeof r.ms === 'number' && r.ms > 0);
  if (timed.length > 0) {
    const fastest = timed.sort((a, b) => a.ms - b.ms)[0];
    const meta = LIBRARY_CATALOG.find((m) => m.id === fastest.id);
    console.log('');
    console.log(`  Fastest this scenario: ${meta?.name ?? fastest.id} (${formatTime(fastest.ms)})`);
  }
}

function printSummaryMatrix(allResults) {
  const activeScenarios = allResults.map((x) => x.scenario);
  const colW = 11;

  console.log('');
  console.log('═'.repeat(110));
  console.log('  SUMMARY MATRIX — median time (ms) per scenario');
  console.log('═'.repeat(110));
  console.log('');

  let header = pad('Library', 22);
  for (const s of activeScenarios) {
    header += pad(s.id, colW);
  }
  console.log(header);
  console.log('─'.repeat(22 + colW * activeScenarios.length));

  for (const meta of LIBRARY_CATALOG) {
    let row = pad(meta.name, 22);
    for (const { results } of allResults) {
      const r = results.find((x) => x.id === meta.id);
      const cell =
        r?.ok === 'CRASH'
          ? 'CRASH'
          : r?.ms == null
          ? 'SKIP'
          : r.ms === Infinity
            ? 'T/O'
            : r.ms < 1000
              ? `${r.ms.toFixed(0)}`
              : `${(r.ms / 1000).toFixed(1)}s`;
      row += pad(cell, colW);
    }
    console.log(row);
  }

  console.log('');
  console.log('  Token-level libs timed E2E where noted (ArenaDiff compare, myers-core tokenize+diff).');
  console.log('  Word/char/line libs use raw text — not directly comparable on change counts.');
}

async function main() {
  let scenarios = SCENARIOS;
  if (quickMode) {
    scenarios = scenarios.filter((s) => s.words <= 15000);
  }
  if (scenarioFilter) {
    scenarios = scenarios.filter((s) => s.id === scenarioFilter || s.id.startsWith(scenarioFilter));
  }
  if (scenarios.length === 0) {
    console.error('No scenarios matched filter.');
    process.exit(1);
  }

  console.log('\nPreparing libraries…');
  const wasmDiffer = new ArenaDiff();
  await wasmDiffer.init();
  const myersCore = new MyersCoreDiff();
  const dnWasmBaseline = diffNativeWasm ? diffNativeWasm.memory.buffer.byteLength : 0;

  console.log('');
  console.log('═'.repeat(110));
  console.log('  EXTENDED CROSS-LIBRARY BENCHMARK');
  console.log('═'.repeat(110));
  console.log('');
  console.log(`  Scenarios : ${scenarios.map((s) => s.id).join(', ')}`);
  console.log(`  Libraries : ${LIBRARY_CATALOG.length} (${LIBRARY_CATALOG.map((l) => l.algorithm).filter((v, i, a) => a.indexOf(v) === i).join(', ')})`);
  console.log(`  Runs      : median of ${RUNS} (warmup ${WARMUP}) · seed ${SEED} · ${LIB_TIMEOUT_MS / 1000}s cap/lib`);
  console.log('');
  console.log('  NOTABLE ALGORITHMS (last ~10 years, text diff):');
  console.log('  • Myers (1986)        — jsdiff, DMP, fast-myers, diff-sequences, myers-core, ArenaDiff');
  console.log('  • Patience (2007/Git) — embedded heuristics in myers-core & ArenaDiff anchors');
  console.log('  • Histogram (2010/Git)— no mature npm port; imara-diff exists on GitHub only');
  console.log('  • fast-diff (2014)    — Quill/DMP-style char diff');
  console.log('  • diff-sequences (2018)— Jest/Facebook linear-space Myers');
  console.log('  • fast-myers-diff (2019)— streaming Myers slices');
  console.log('  • diff-native (2023)  — Rust/WASM word diff');

  const allResults = [];

  for (const scenario of scenarios) {
    console.log(`\nRunning scenario: ${scenario.label}…`);
    const { textA, textB } = buildScenarioInputs(scenario, SEED);
    const tokensA = tokenize(textA);
    const tokensB = tokenize(textB);
    const interner = new StringInterner();
    const idsA = textToIds(textA, interner);
    const idsB = textToIds(textB, interner);
    const runBaseline = shouldRunBaseline(idsA.length, idsB.length);
    const baselineMatrixBytes = (idsA.length + 1) * (idsB.length + 1) * 4;

    const ctx = {
      textA,
      textB,
      tokensA,
      tokensB,
      idsA,
      idsB,
      interner,
      wasmDiffer,
      myersCore,
      dnWasmBaseline,
      baselineMatrixBytes,
      runBaseline,
    };

    const results = [];
    for (const meta of LIBRARY_CATALOG) {
      process.stdout.write(`  · ${meta.name}…`);
      let r;
      try {
        r = await runLibrary(meta.id, ctx, scenario);
      } catch (err) {
        r = {
          ms: Infinity,
          memory: null,
          memoryNote: 'error',
          ok: 'CRASH',
          error: err?.message ?? String(err),
        };
      }
      results.push({ id: meta.id, ...r });
      process.stdout.write(` ${r.ok === 'CRASH' ? 'CRASH' : formatTime(r.ms)}\n`);
    }

    const input = {
      wordsA: countWords(textA),
      wordsB: countWords(textB),
      tokensA: tokensA.length,
      tokensB: tokensB.length,
      charsA: textA.length,
      charsB: textB.length,
    };

    printScenarioTable(scenario, input, results);
    allResults.push({ scenario, results });
  }

  printSummaryMatrix(allResults);
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
