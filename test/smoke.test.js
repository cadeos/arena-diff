/**
 * Smoke test — library API and WASM diff (no baseline matrix).
 */

import {
  ArenaDiff,
  tokenize,
  textToIds,
  serializeDiff,
  applyDiff,
  StringInterner,
} from '../src/index.js';

const textA = 'Hello, world! The quick brown fox.';
const textB = 'Hello, brave world! The quick red fox jumps.';

const interner = new StringInterner();
const idsA = textToIds(textA, interner);
const idsB = textToIds(textB, interner);

if (tokenize(textA).length !== idsA.length) {
  throw new Error('tokenize / textToIds length mismatch');
}

const differ = new ArenaDiff();
await differ.init();
const result = await differ.compare(textA, textB);

if (result.keepCount + result.insertCount + result.deleteCount !== result.ops.length) {
  throw new Error('op counts do not sum to ops.length');
}

const rebuilt = applyDiff(tokenize(textA), result);
if (rebuilt !== tokenize(textB).join('')) {
  throw new Error('applyDiff failed to reconstruct textB');
}

if (!serializeDiff(result).includes('keep:Hello')) {
  throw new Error('serializeDiff unexpected output');
}

console.log('OK —', result.ops.length, 'ops, arena', differ.lastArenaBytes, 'bytes');
