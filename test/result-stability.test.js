/**
 * Results must stay valid after subsequent compare() calls on the same instance.
 */

import { ArenaDiff, applyDiff, tokenize } from '../src/index.js';

const differ = new ArenaDiff();
await differ.init();

const textA = 'the cat sat on the mat';
const textB = 'the dog sat on the mat';

const result = await differ.compare(textA, textB);

const big = Array.from({ length: 200_000 }, (_, i) => `w${i % 1000}`).join(' ');
const big2 = Array.from({ length: 200_000 }, (_, i) => `w${(i + 1) % 1000}`).join(' ');
await differ.compare(big, big2);

if (result.ops.length === 0) {
  throw new Error('result.ops became empty after a later compare()');
}

const rebuilt = applyDiff(tokenize(textA), result);
if (rebuilt !== textB) {
  throw new Error(`applyDiff stale after later compare(): got ${JSON.stringify(rebuilt)}`);
}

if (result.keepCount + result.insertCount + result.deleteCount !== result.ops.length) {
  throw new Error('op counts do not sum to ops.length after a later compare()');
}

console.log('OK — result stable across subsequent compare() calls');
