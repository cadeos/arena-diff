/**
 * O(N×M) LCS baseline for correctness checks in research/benchmarks only.
 * Will OOM on large inputs — not part of the published library API.
 */

/**
 * @param {import('../src/index.js').StringInterner} interner
 */
export function baselineDiff(idsA, idsB, interner) {
  const n = idsA.length;
  const m = idsB.length;

  const dp = new Int32Array((n + 1) * (m + 1));
  const idx = (i, j) => i * (m + 1) + j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (idsA[i - 1] === idsB[j - 1]) {
        dp[idx(i, j)] = dp[idx(i - 1, j - 1)] + 1;
      } else {
        dp[idx(i, j)] = Math.max(dp[idx(i - 1, j)], dp[idx(i, j - 1)]);
      }
    }
  }

  const lcs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (idsA[i - 1] === idsB[j - 1]) {
      lcs.unshift(idsA[i - 1]);
      i--;
      j--;
    } else if (dp[idx(i - 1, j)] >= dp[idx(i, j - 1)]) {
      i--;
    } else {
      j--;
    }
  }

  return lcsToDiffResult(idsA, idsB, lcs, interner);
}

function lcsToDiffResult(idsA, idsB, lcs, interner) {
  const ops = [];
  let keepCount = 0;
  let insertCount = 0;
  let deleteCount = 0;

  let i = 0;
  let j = 0;
  let k = 0;
  const n = idsA.length;
  const m = idsB.length;

  while (i < n || j < m) {
    if (k < lcs.length && i < n && j < m && idsA[i] === lcs[k] && idsB[j] === lcs[k]) {
      ops.push({ op: 'keep', token: interner.lookup(idsA[i]) });
      keepCount++;
      i++;
      j++;
      k++;
    } else if (k < lcs.length && i < n && idsA[i] === lcs[k]) {
      ops.push({ op: 'insert', token: interner.lookup(idsB[j]) });
      insertCount++;
      j++;
    } else if (k < lcs.length && j < m && idsB[j] === lcs[k]) {
      ops.push({ op: 'delete', token: interner.lookup(idsA[i]) });
      deleteCount++;
      i++;
    } else if (i < n && (j >= m || (k < lcs.length && idsA[i] !== lcs[k]))) {
      ops.push({ op: 'delete', token: interner.lookup(idsA[i]) });
      deleteCount++;
      i++;
    } else if (j < m) {
      ops.push({ op: 'insert', token: interner.lookup(idsB[j]) });
      insertCount++;
      j++;
    } else {
      break;
    }
  }

  return { ops, keepCount, insertCount, deleteCount };
}
