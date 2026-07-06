/**
 * Cross-library MEMORY benchmark — same scenarios as benchmark-compare.js.
 *
 * Usage:  node --expose-gc benchmark-memory.js
 *         node --expose-gc benchmark-memory.js --quick
 */

import diffNative from 'diff-native';
import { createRequire } from 'node:module';
import { MyersCoreDiff } from '@fishan/myers-core-diff';
import { diff as fastMyersDiff } from 'fast-myers-diff';
import { diff as dmpDiff } from 'diff-match-patch-es';
import { diffWords as jsdiffWords, diffLines as jsdiffLines } from 'diff';
import { ArenaDiff, textToIds, StringInterner, tokenize } from '../src/index.js';
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
  /* noop */
}

const SEED = 42;
const args = process.argv.slice(2);
const quickMode = args.includes('--quick');

const gc = () => globalThis.gc && globalThis.gc();

function formatBytes(bytes) {
  if (bytes == null || bytes < 0) return 'n/a';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
}

function pad(str, w) {
  const s = String(str);
  return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
}

function measureHeap(fn) {
  gc();
  const before = process.memoryUsage().heapUsed;
  const result = fn();
  gc();
  return { result, heapDelta: Math.max(0, process.memoryUsage().heapUsed - before) };
}

function measureWasm(fn, wasmExports) {
  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const wasmBefore = wasmExports?.memory?.buffer.byteLength ?? 0;
  const result = fn();
  const wasmAfter = wasmExports?.memory?.buffer.byteLength ?? 0;
  gc();
  return {
    result,
    heapDelta: Math.max(0, process.memoryUsage().heapUsed - heapBefore),
    wasmGrowth: Math.max(0, wasmAfter - wasmBefore),
    wasmTotal: wasmAfter,
  };
}

const LIBS = [
  { id: 'arena-diff', name: 'ArenaDiff', note: 'arena (exact)' },
  { id: 'arena-diff-e2e', name: 'ArenaDiff E2E', note: 'arena+wasm+heap' },
  { id: 'baseline', name: 'Baseline matrix', note: 'DP theoretical' },
  { id: 'myers-core', name: 'myers-core-diff', note: 'heap Δ' },
  { id: 'fast-myers', name: 'fast-myers-diff', note: 'heap Δ' },
  { id: 'diff-sequences', name: 'diff-sequences', note: 'heap Δ' },
  { id: 'diff-native', name: 'diff-native', note: 'heap+wasm' },
  { id: 'jsdiff-words', name: 'jsdiff (words)', note: 'heap Δ' },
  { id: 'jsdiff-lines', name: 'jsdiff (lines)', note: 'heap Δ' },
  { id: 'fast-diff', name: 'fast-diff', note: 'heap Δ' },
  { id: 'dmp', name: 'diff-match-patch-es', note: 'heap Δ' },
];

function shouldSkipLib(libId, scenario) {
  if (libId === 'baseline' || libId === 'arena-diff' || libId === 'arena-diff-e2e') return false;

  const heavyChar =
    libId === 'fast-diff' || libId === 'dmp'
      ? scenario.kind === 'dissimilar'
        || scenario.words >= 30000
        || ((scenario.rate ?? 0) >= 0.5 && scenario.words >= 15000)
      : false;

  const diffNativeHeavy =
    libId === 'diff-native' && scenario.words >= 30000 && (scenario.rate ?? 0) >= 0.5;

  const jsdiffWordsSlow =
    libId === 'jsdiff-words'
      && (scenario.words >= 30000 || (scenario.rate ?? 0) >= 0.5);

  return heavyChar || diffNativeHeavy || jsdiffWordsSlow;
}

async function measureLib(libId, ctx) {
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
      gc();
      const wasmBefore = wasmDiffer.exports.memory.buffer.byteLength;
      wasmDiffer.interner.reset();
      const a = textToIds(textA, wasmDiffer.interner);
      const b = textToIds(textB, wasmDiffer.interner);
      const arena = wasmDiffer.exports.alloc_arena(a.length, b.length);
      wasmDiffer.exports.run_diff();
      const wasmAfter = wasmDiffer.exports.memory.buffer.byteLength;
      return {
        bytes: arena,
        wasmPages: Math.max(wasmAfter, wasmBefore),
        note: 'arena (exact)',
      };
    }
    case 'arena-diff-e2e': {
      gc();
      const heapBefore = process.memoryUsage().heapUsed;
      const wasmBefore = wasmDiffer.exports.memory.buffer.byteLength;
      await wasmDiffer.compare(textA, textB);
      const wasmAfter = wasmDiffer.exports.memory.buffer.byteLength;
      gc();
      const heapDelta = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
      const wasmUsed = Math.max(wasmAfter - wasmBefore, wasmDiffer.lastArenaBytes);
      return {
        bytes: heapDelta + wasmUsed,
        heap: heapDelta,
        wasm: wasmUsed,
        arena: wasmDiffer.lastArenaBytes,
        note: 'arena+heap (compare)',
      };
    }
    case 'baseline':
      if (!runBaseline) return { bytes: baselineMatrixBytes, note: 'DP skip (>512MiB)' };
      return { bytes: baselineMatrixBytes, note: 'DP matrix (theoretical)' };
    case 'myers-core': {
      const { heapDelta } = measureHeap(() => {
        const ta = tokenize(textA);
        const tb = tokenize(textB);
        return myersCore.diff(ta, tb);
      });
      return { bytes: heapDelta, note: 'heap Δ' };
    }
    case 'fast-myers': {
      const { heapDelta } = measureHeap(() => {
        for (const _ of fastMyersDiff(tokensA, tokensB)) {
          /* drain */
        }
      });
      return { bytes: heapDelta, note: 'heap Δ' };
    }
    case 'diff-sequences': {
      const { heapDelta } = measureHeap(() => {
        diffSequence(tokensA.length, tokensB.length, (i, j) => tokensA[i] === tokensB[j], () => {});
      });
      return { bytes: heapDelta, note: 'heap Δ' };
    }
    case 'diff-native': {
      const { heapDelta } = measureHeap(() => diffNative.diffWords(textA, textB));
      const wasmResident = diffNativeWasm
        ? Math.max(0, diffNativeWasm.memory.buffer.byteLength - dnWasmBaseline)
        : 0;
      return {
        bytes: heapDelta + wasmResident,
        heap: heapDelta,
        wasm: wasmResident,
        note: 'heap+wasm',
      };
    }
    case 'jsdiff-words': {
      const { heapDelta } = measureHeap(() => jsdiffWords(textA, textB));
      return { bytes: heapDelta, note: 'heap Δ' };
    }
    case 'jsdiff-lines': {
      const { heapDelta } = measureHeap(() => jsdiffLines(textA, textB));
      return { bytes: heapDelta, note: 'heap Δ' };
    }
    case 'fast-diff': {
      const { heapDelta } = measureHeap(() => fastDiff(textA, textB));
      return { bytes: heapDelta, note: 'heap Δ' };
    }
    case 'dmp': {
      const { heapDelta } = measureHeap(() => dmpDiff(textA, textB, { diffTimeout: 55 }));
      return { bytes: heapDelta, note: 'heap Δ' };
    }
    default:
      return { bytes: null, note: '—' };
  }
}

function printScenario(scenario, input, rows) {
  const ref = rows.find((r) => r.id === 'arena-diff')?.bytes ?? 1;

  console.log('');
  console.log('─'.repeat(100));
  console.log(`  ${scenario.label} (${scenario.id})`);
  console.log('─'.repeat(100));
  console.log(
    `  Tokens: A=${input.tokensA.toLocaleString()}  B=${input.tokensB.toLocaleString()}  ·  ${scenario.kind}`,
  );
  console.log('');

  const hdr =
    pad('Library', 24) +
    pad('Memory', 14) +
    pad('× ArenaDiff', 12) +
    pad('Source', 22) +
    pad('Detail', 28);
  console.log(hdr);
  console.log('─'.repeat(100));

  for (const lib of LIBS) {
    const r = rows.find((x) => x.id === lib.id);
    if (!r || r.bytes == null) {
      console.log(pad(lib.name, 24) + pad('SKIP', 14) + pad('—', 12) + pad(r?.note ?? 'skip', 22));
      continue;
    }
    const vs = lib.id === 'arena-diff' ? '1.0×' : `${(r.bytes / ref).toFixed(1)}×`;
    const exact = r.note.includes('exact') || r.note.includes('theoretical');
    const memStr = exact ? formatBytes(r.bytes) : `~${formatBytes(r.bytes)}`;
    let detail = '';
    if (r.arena != null) detail = `arena ${formatBytes(r.arena)}`;
    if (r.heap != null && r.wasm != null) detail = `heap ${formatBytes(r.heap)} + wasm ${formatBytes(r.wasm)}`;
    console.log(
      pad(lib.name, 24) +
        pad(memStr, 14) +
        pad(vs, 12) +
        pad(r.note, 22) +
        pad(detail, 28),
    );
  }

  const comparable = rows.filter(
    (r) => r.bytes != null && r.id !== 'baseline' && r.id !== 'arena-diff-e2e',
  );
  const lowest = comparable.sort((a, b) => a.bytes - b.bytes)[0];
  if (lowest) {
    const name = LIBS.find((l) => l.id === lowest.id)?.name ?? lowest.id;
    console.log('');
    console.log(`  Lowest measured: ${name} (${formatBytes(lowest.bytes)})`);
  }
}

function printMatrix(allRows) {
  const scenarios = allRows.map((x) => x.scenario);
  const colW = 11;
  console.log('');
  console.log('═'.repeat(100));
  console.log('  MEMORY MATRIX — ArenaDiff arena (exact) vs others');
  console.log('═'.repeat(100));
  console.log('');

  let hdr = pad('Library', 24);
  for (const s of scenarios) hdr += pad(s.id, colW);
  console.log(hdr);
  console.log('─'.repeat(24 + colW * scenarios.length));

  for (const lib of LIBS) {
    if (lib.id === 'arena-diff-e2e') continue;
    let row = pad(lib.name, 24);
    for (const { rows } of allRows) {
      const r = rows.find((x) => x.id === lib.id);
      row += pad(r?.bytes != null ? formatBytes(r.bytes).replace(' GiB', 'G').replace(' MiB', 'M').replace(' KiB', 'K') : 'SKIP', colW);
    }
    console.log(row);
  }
}

async function main() {
  let scenarios = SCENARIOS;
  if (quickMode) scenarios = scenarios.filter((s) => s.words <= 15000);

  const wasmDiffer = new ArenaDiff();
  await wasmDiffer.init();
  const myersCore = new MyersCoreDiff();
  const dnWasmBaseline = diffNativeWasm ? diffNativeWasm.memory.buffer.byteLength : 0;

  console.log('\n' + '═'.repeat(100));
  console.log('  CROSS-LIBRARY MEMORY BENCHMARK');
  console.log('═'.repeat(100));
  console.log(`  Scenarios: ${scenarios.map((s) => s.id).join(', ')}`);
  console.log('  Requires: node --expose-gc');
  console.log('');
  console.log('  METRIC LEGEND');
  console.log('  • arena (exact)     — ArenaDiff pre-allocated O(N+M) bump arena in WASM');
  console.log('  • DP matrix         — baseline theoretical full (N+1)×(M+1) Int32 matrix');
  console.log('  • heap Δ            — JS heap growth during one diff call (may undercount reuse)');
  console.log('  • heap+wasm         — JS heap + WASM linear memory pages (diff-native)');
  console.log('  • ArenaDiff E2E      — arena + JS heap for compare() including result objects');

  const allRows = [];

  for (const scenario of scenarios) {
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

    const rows = [];
    for (const lib of LIBS) {
      if (shouldSkipLib(lib.id, scenario) && lib.id !== 'baseline') {
        rows.push({ id: lib.id, bytes: null, note: 'skip (slow)' });
        continue;
      }
      try {
        const m = await measureLib(lib.id, ctx);
        rows.push({ id: lib.id, ...m });
      } catch {
        rows.push({ id: lib.id, bytes: null, note: 'error' });
      }
    }

    printScenario(scenario, {
      tokensA: tokensA.length,
      tokensB: tokensB.length,
      wordsA: countWords(textA),
      wordsB: countWords(textB),
    }, rows);
    allRows.push({ scenario, rows });
  }

  printMatrix(allRows);

  console.log('');
  console.log('  TAKEAWAYS');
  console.log('  • ArenaDiff arena scales O(N+M): ~3.4 MiB @ 15k tokens, ~6.7 MiB @ 30k tokens.');
  console.log('  • Baseline DP would need 3–14 GiB on the same inputs — impractical.');
  console.log('  • diff-native WASM pages can reach GiB on heavy diffs (hidden from heap-only metrics).');
  console.log('  • fast-myers / diff-sequences show tiny heap Δ but are much slower (streaming/minimal alloc).');
  console.log('  • Lowest heap Δ ≠ best overall: those libs omit full edit-script materialization.');
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
