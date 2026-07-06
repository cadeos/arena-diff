/**
 * Verify WASM memory grows on demand for large inputs.
 */

import { ArenaDiff, tokenize, applyDiff } from '../src/index.js';
import { generateText, mutateText } from '../research/benchmark-data.js';

const differ = new ArenaDiff();
await differ.init();

const textA = generateText(120000, 42);
const textB = mutateText(textA, 0.05, 42);

const wasmBefore = differ.exports.memory.buffer.byteLength;
const result = await differ.compare(textA, textB);
const wasmAfter = differ.exports.memory.buffer.byteLength;

if (wasmAfter <= 16 * 1024 * 1024) {
  throw new Error(`expected WASM memory to grow beyond 16 MiB, got ${wasmAfter}`);
}

const ok = applyDiff(tokenize(textA), result) === tokenize(textB).join('');
if (!ok) {
  throw new Error('applyDiff failed on 120k-word input');
}

console.log(
  'OK — memory grow',
  `${(wasmBefore / 1024 / 1024).toFixed(0)} → ${(wasmAfter / 1024 / 1024).toFixed(0)} MiB`,
  `arena ${(differ.lastArenaBytes / 1024 / 1024).toFixed(2)} MiB`,
);
