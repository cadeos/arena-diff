export type DiffOp = { op: 'keep' | 'insert' | 'delete'; token: string };

export type WasmViews = {
  opsView: Int8Array;
  idxView: Int32Array;
  idsA: Int32Array;
  idsB: Int32Array;
  tokenTable: string[];
  resultLen: number;
};

export type DiffResult = {
  readonly ops: DiffOp[];
  keepCount: number;
  insertCount: number;
  deleteCount: number;
  _wasmViews?: WasmViews;
};

export type ArenaDiffOptions = {
  /** Override the inlined WASM binary (advanced; default uses the bundled engine). */
  wasmBinary?: BufferSource;
  /** Optional JS-side cap on WASM growth (default: none — grow until runtime limit). */
  maxMemoryBytes?: number;
};

export class StringInterner {
  intern(token: string): number;
  lookup(id: number): string;
  reset(): void;
}

export type ToTeiDiffOptions = {
  /** Wrap output in a minimal TEI P5 XML document. */
  wrapDocument?: boolean;
  title?: string;
};

export function tokenize(text: string): string[];
export function textToIds(text: string, interner: StringInterner): Int32Array;
export function serializeDiff(result: DiffResult): string;
export function toTeiDiff(result: DiffResult, options?: ToTeiDiffOptions): string;
export function applyDiff(tokensA: string[], result: DiffResult): string;

export const OP_KEEP: 0;
export const OP_INSERT: 1;
export const OP_DELETE: -1;

export class ArenaDiff {
  lastArenaBytes: number | undefined;
  /** Undefined = no cap; set via constructor for embedder guardrails. */
  maxMemoryBytes: number | undefined;
  /** Override for the inlined WASM binary (advanced). */
  wasmBinary: BufferSource | undefined;
  interner: StringInterner;
  constructor(options?: ArenaDiffOptions);
  init(): Promise<this>;
  estimateArenaBytes(tokenCountA: number, tokenCountB: number): Promise<number>;
  compare(textA: string, textB: string): Promise<DiffResult>;
}