/**
 * Round-trip correctness when guided_diff handles large gaps (similar texts).
 */

import { ArenaDiff, tokenize, applyDiff } from '../src/index.js';
import { generateText, mutateText } from '../research/benchmark-data.js';

function assertRoundTrip(textA, textB, label) {
  const differ = new ArenaDiff();
  return differ.compare(textA, textB).then((result) => {
    const bad = result.ops.filter((o) => o.token === undefined).length;
    if (bad > 0) {
      throw new Error(`${label}: ${bad} ops with undefined token`);
    }
    const rebuilt = applyDiff(tokenize(textA), result);
    const expected = tokenize(textB).join('');
    if (rebuilt !== expected) {
      throw new Error(
        `${label}: applyDiff mismatch (len ${rebuilt.length} vs ${expected.length})`,
      );
    }
    if (result.keepCount + result.insertCount + result.deleteCount !== result.ops.length) {
      throw new Error(`${label}: op counts do not sum to ops.length`);
    }
    return result;
  });
}

const cases = [
  ['similar 15k ~5%', generateText(15000, 1), null, 0.05, 42],
  ['similar 30k ~5%', generateText(30000, 2), null, 0.05, 43],
  ['similar 30k ~8%', generateText(30000, 3), null, 0.08, 44],
  ['similar 80k ~5%', generateText(80000, 4), null, 0.05, 45],
  ['dissimilar 30k', generateText(30000, 10), generateText(30000, 11), null, null],
  ['length ratio ~2:1', generateText(40000, 20), generateText(80000, 21), null, null],
];

for (const [label, base, other, rate, seed] of cases) {
  const textA = base;
  const textB = other ?? mutateText(base, rate, seed);
  const t0 = performance.now();
  await assertRoundTrip(textA, textB, label);
  const ms = (performance.now() - t0).toFixed(1);
  console.log(`OK — ${label} (${ms} ms)`);
}
