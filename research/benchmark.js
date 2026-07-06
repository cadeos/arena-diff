/**
 * ArenaDiff benchmark — readable report comparing baseline vs WASM Myers engine.
 */

import { ArenaDiff, textToIds, StringInterner, tokenize, applyDiff } from '../src/index.js';
import { baselineDiff } from './baseline.js';

const WORD_COUNT = 15000;
const MUTATION_RATE = 0.08;

const VOCAB = [
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
  'shall', 'can', 'need', 'dare', 'ought', 'used', 'algorithm', 'memory', 'browser',
  'wasm', 'javascript', 'token', 'diff', 'linear', 'space', 'performance', 'optimize',
  'compare', 'sequence', 'matrix', 'crash', 'freeze', 'engine', 'wrapper', 'benchmark',
];

const PUNCT = ['.', ',', ';', ':', '!', '?', '—', '(', ')', '"', "'"];
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

function randInt(max) {
  return Math.floor(Math.random() * max);
}

function randomWord() {
  return VOCAB[randInt(VOCAB.length)];
}

function randomPunct() {
  return PUNCT[randInt(PUNCT.length)];
}

function generateText(wordCount) {
  const parts = [];
  for (let i = 0; i < wordCount; i++) {
    parts.push(randomWord());
    if (i > 0 && i % 17 === 0) parts.push(randomPunct());
    if (i < wordCount - 1) parts.push(' ');
  }
  return parts.join('');
}

function mutateText(baseText, mutationRate) {
  const words = baseText.split(/(\s+|[.,;:!?—()"'])/).filter((s) => s.length > 0);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const roll = Math.random();
    if (roll < mutationRate * 0.4) {
      out.push(randomWord(), ' ', words[i]);
    } else if (roll < mutationRate * 0.7) {
      continue;
    } else if (roll < mutationRate) {
      out.push(randomWord());
    } else {
      out.push(words[i]);
    }
  }
  return out.join('');
}

/** Count word-like tokens (excludes spaces and punctuation). */
function countWords(text) {
  let n = 0;
  for (const { isWordLike } of segmenter.segment(text)) {
    if (isWordLike) n++;
  }
  return n;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function formatTime(ms) {
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function padRight(str, width) {
  const s = String(str);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function padLeft(str, width) {
  const s = String(str);
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function line(char = '─', width = 72) {
  return char.repeat(width);
}

function row(label, col1, col2, col3) {
  console.log(`  ${padRight(label, 28)} ${padLeft(col1, 14)} ${padLeft(col2, 14)} ${padLeft(col3, 14)}`);
}

async function main() {
  const textA = generateText(WORD_COUNT);
  const textB = mutateText(textA, MUTATION_RATE);

  const wordsA = countWords(textA);
  const wordsB = countWords(textB);
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);
  const charsA = textA.length;
  const charsB = textB.length;

  const interner = new StringInterner();
  const idsA = textToIds(textA, interner);
  const idsB = textToIds(textB, interner);

  const baselineMatrixBytes = (idsA.length + 1) * (idsB.length + 1) * 4;

  const differ = new ArenaDiff();
  await differ.init();

  // --- baseline ---
  let baselineResult = null;
  let baselineTime = null;
  try {
    const t0 = performance.now();
    baselineResult = baselineDiff(idsA, idsB, interner);
    baselineTime = performance.now() - t0;
  } catch (err) {
    console.error(`Baseline failed: ${err.message}`);
  }

  // --- wasm ---
  const t0 = performance.now();
  const wasmResult = await differ.compare(textA, textB);
  const wasmTime = performance.now() - t0;
  const wasmArenaBytes = differ.lastArenaBytes;

  const result = wasmResult;
  const inserts = result.insertCount;
  const deletes = result.deleteCount;
  const keeps = result.keepCount;
  const totalChanges = inserts + deletes;
  const changePct = ((totalChanges / (keeps + totalChanges)) * 100).toFixed(1);

  // correctness — guided diff may decompose ops differently than Myers baseline
  const tokensBStr = tokensB.join('');
  const semanticOk = applyDiff(tokensA, wasmResult) === tokensBStr;

  // --- report ---
  console.log('');
  console.log(line('═'));
  console.log('  ArenaDiff Benchmark Report');
  console.log(line('═'));
  console.log('');

  console.log('  INPUT FILES');
  console.log(line());
  row('Metric', 'File A', 'File B', '');
  console.log(line());
  row('Words', wordsA.toLocaleString(), wordsB.toLocaleString(), '');
  row('Tokens (incl. spaces/punct)', tokensA.length.toLocaleString(), tokensB.length.toLocaleString(), '');
  row('Characters', charsA.toLocaleString(), charsB.toLocaleString(), '');
  row('Unique token dictionary', interner.reverse.length.toLocaleString(), '', '');
  console.log('');

  console.log('  DIFF RESULT');
  console.log(line());
  row('Operation', 'Count', '% of ops', '');
  console.log(line());
  const totalOps = keeps + inserts + deletes;
  row('Kept (unchanged)', keeps.toLocaleString(), `${((keeps / totalOps) * 100).toFixed(1)}%`, '');
  row('Inserted', inserts.toLocaleString(), `${((inserts / totalOps) * 100).toFixed(1)}%`, '');
  row('Deleted', deletes.toLocaleString(), `${((deletes / totalOps) * 100).toFixed(1)}%`, '');
  console.log(line());
  row('Total changes (ins + del)', totalChanges.toLocaleString(), `${changePct}% of tokens`, '');
  console.log('');

  console.log('  PERFORMANCE');
  console.log(line());
  row('', 'Baseline (JS)', 'ArenaDiff (WASM)', 'Ratio');
  console.log(line());

  if (baselineTime !== null) {
    const speedup = baselineTime / wasmTime;
    row('Execution time', formatTime(baselineTime), formatTime(wasmTime), `${speedup.toFixed(1)}× faster`);
  } else {
    row('Execution time', 'OOM / failed', formatTime(wasmTime), '—');
  }
  console.log('');

  console.log('  MEMORY');
  console.log(line());
  row('', 'Baseline (JS)', 'ArenaDiff (WASM)', 'Ratio');
  console.log(line());
  const memRatio = baselineMatrixBytes / wasmArenaBytes;
  row('Peak working set', formatBytes(baselineMatrixBytes), formatBytes(wasmArenaBytes), `${memRatio.toFixed(0)}× less`);
  row(
    'Structure',
    `DP matrix ${(idsA.length + 1).toLocaleString()}×${(idsB.length + 1).toLocaleString()}`,
    'O(N+M) arena',
    ''
  );
  console.log('');

  console.log('  CORRECTNESS');
  console.log(line());
  console.log(`  Reconstructs File B from File A : ${semanticOk ? 'PASS' : 'FAIL'}`);
  if (baselineResult) {
    console.log('  Op counts match baseline        : N/A (guided script)');
  } else {
    console.log('  Baseline comparison             : skipped (baseline OOM)');
  }
  console.log('');

  console.log(line('═'));
  console.log(
    `  Summary: ${wordsA.toLocaleString()} vs ${wordsB.toLocaleString()} words, ` +
      `${totalChanges.toLocaleString()} changes` +
      (baselineTime !== null
        ? ` — ArenaDiff is ${(baselineTime / wasmTime).toFixed(1)}× faster, uses ${memRatio.toFixed(0)}× less memory`
        : ` — ArenaDiff completed where baseline failed`)
  );
  console.log(line('═'));
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
