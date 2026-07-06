Dev-only tools: cross-library benchmarks, memory profiling, and correctness audits.

Not included in the npm package. Requires `npm install` at the repo root (devDependencies).

```bash
npm run research:compare        # time vs jsdiff, myers-core, diff-native, …
npm run research:memory         # arena vs heap metrics
node --expose-gc research/diagnose.js
node research/benchmark-audit.js
```
