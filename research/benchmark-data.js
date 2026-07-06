/**
 * Shared synthetic text generators and benchmark scenario definitions.
 */

export const VOCAB = [
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
  'shall', 'can', 'need', 'dare', 'ought', 'used', 'algorithm', 'memory', 'browser',
  'wasm', 'javascript', 'token', 'diff', 'linear', 'space', 'performance', 'optimize',
  'compare', 'sequence', 'matrix', 'crash', 'freeze', 'engine', 'wrapper', 'benchmark',
  'histogram', 'patience', 'myers', 'anchor', 'heuristic', 'document', 'revision',
];

export const PUNCT = ['.', ',', ';', ':', '!', '?', '—', '(', ')', '"', "'"];

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

export function generateText(wordCount, seed = null) {
  const parts = [];
  let rnd = Math.random;
  if (seed != null) {
    let s = seed >>> 0;
    rnd = () => {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  for (let i = 0; i < wordCount; i++) {
    parts.push(VOCAB[Math.floor(rnd() * VOCAB.length)]);
    if (i > 0 && i % 17 === 0) parts.push(PUNCT[Math.floor(rnd() * PUNCT.length)]);
    if (i < wordCount - 1) {
      // ~15 words per line so line-level diffs are meaningful.
      parts.push(i > 0 && i % 15 === 0 ? '\n' : ' ');
    }
  }
  return parts.join('');
}

export function mutateText(baseText, mutationRate, seed = null) {
  let rnd = Math.random;
  if (seed != null) {
    let s = (seed + 1) >>> 0;
    rnd = () => {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  const words = baseText.split(/(\s+|[.,;:!?—()"']|\n)/).filter((x) => x.length > 0);
  const out = [];
  for (const word of words) {
    const roll = rnd();
    if (roll < mutationRate * 0.4) {
      out.push(VOCAB[Math.floor(rnd() * VOCAB.length)], ' ', word);
    } else if (roll < mutationRate * 0.7) {
      continue;
    } else if (roll < mutationRate) {
      out.push(VOCAB[Math.floor(rnd() * VOCAB.length)]);
    } else {
      out.push(word);
    }
  }
  return out.join('');
}

export function countWords(text) {
  let n = 0;
  for (const { isWordLike } of segmenter.segment(text)) {
    if (isWordLike) n++;
  }
  return n;
}

/**
 * @typedef {'similar' | 'dissimilar'} ScenarioKind
 * @typedef {object} BenchmarkScenario
 * @property {string} id
 * @property {string} label
 * @property {number} words
 * @property {ScenarioKind} kind
 * @property {number} [rate] mutation rate for similar scenarios
 * @property {boolean} [includeBaseline] force baseline matrix (default: auto)
 */

/** Scenarios up to 30k words (similar + dissimilar). */
export const SCENARIOS = [
  { id: 'sim-15k-8', label: 'Similar 15k (~8%)', words: 15000, kind: 'similar', rate: 0.08 },
  { id: 'sim-15k-50', label: 'Similar 15k (~50%)', words: 15000, kind: 'similar', rate: 0.50 },
  { id: 'dissim-15k', label: 'Dissimilar 15k', words: 15000, kind: 'dissimilar' },
  { id: 'sim-30k-8', label: 'Similar 30k (~8%)', words: 30000, kind: 'similar', rate: 0.08 },
  { id: 'sim-30k-50', label: 'Similar 30k (~50%)', words: 30000, kind: 'similar', rate: 0.50 },
  { id: 'dissim-30k', label: 'Dissimilar 30k', words: 30000, kind: 'dissimilar' },
];

export function buildScenarioInputs(scenario, seed = 42) {
  const textA = generateText(scenario.words, seed);
  const textB =
    scenario.kind === 'dissimilar'
      ? generateText(scenario.words, seed + 999)
      : mutateText(textA, scenario.rate ?? 0.08, seed);

  return { textA, textB };
}

export function shouldRunBaseline(tokenCountA, tokenCountB) {
  const cells = (tokenCountA + 1) * (tokenCountB + 1);
  // Skip when DP matrix would exceed ~512 MiB.
  return cells * 4 <= 512 * 1024 * 1024;
}
