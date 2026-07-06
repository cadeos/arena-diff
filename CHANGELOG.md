# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-07-05

### Added

- Word-level diff engine with C/WASM core and O(N+M) arena memory.
- `ArenaDiff` API with lazy `ops` getter and eager counts.
- Inlined WASM binary for zero-config use via `npm install` (Node, browsers, bundlers).
- Benchmark suite in `research/` for cross-library comparison.

### Fixed

- Diff results remain valid after subsequent `compare()` calls on the same instance.
