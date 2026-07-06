/**
 * arena-diff — word-level text diff with a C/WASM core and O(N+M) arena memory.
 */

import { wasmBase64 } from './wasm/diff.wasm.js';

const OP_KEEP = 0;
const OP_INSERT = 1;
const OP_DELETE = -1;

/** Maps unique token strings to 32-bit integer IDs. */
class StringInterner {
  constructor() {
    /** @type {Map<string, number>} */
    this.dict = new Map();
    /** @type {string[]} */
    this.reverse = [];
  }

  /** @param {string} token */
  intern(token) {
    let id = this.dict.get(token);
    if (id === undefined) {
      id = this.reverse.length;
      this.dict.set(token, id);
      this.reverse.push(token);
    }
    return id;
  }

  /** @param {number} id */
  lookup(id) {
    return this.reverse[id];
  }

  reset() {
    this.dict.clear();
    this.reverse.length = 0;
  }
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

/**
 * Split text into word tokens; spaces and punctuation are separate tokens.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const tokens = [];
  for (const { segment } of segmenter.segment(text)) {
    if (segment.length > 0) {
      tokens.push(segment);
    }
  }
  return tokens;
}

/**
 * Tokenize and intern into a shared dictionary; returns Int32Array of IDs.
 * @param {string} text
 * @param {StringInterner} interner
 * @returns {Int32Array}
 */
export function textToIds(text, interner) {
  const tokens = tokenize(text);
  const ids = new Int32Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    ids[i] = interner.intern(tokens[i]);
  }
  return ids;
}

/**
 * Copy the token strings referenced by idsA/idsB so a result stays valid after
 * the shared interner is reset by a later compare().
 * @param {Int32Array} idsA
 * @param {Int32Array} idsB
 * @param {StringInterner} interner
 * @returns {string[]}
 */
function snapshotTokenTable(idsA, idsB, interner) {
  let maxId = -1;
  for (let i = 0; i < idsA.length; i++) {
    if (idsA[i] > maxId) maxId = idsA[i];
  }
  for (let i = 0; i < idsB.length; i++) {
    if (idsB[i] > maxId) maxId = idsB[i];
  }
  if (maxId < 0) {
    return [];
  }
  return interner.reverse.slice(0, maxId + 1);
}

/**
 * @param {Int8Array} opsView
 * @param {Int32Array} idxView
 * @param {Int32Array} idsA
 * @param {Int32Array} idsB
 * @param {string[]} tokenTable
 * @param {number} resultLen
 */
function hydrateOpsFromViews(opsView, idxView, idsA, idsB, tokenTable, resultLen) {
  const ops = [];
  for (let r = 0; r < resultLen; r++) {
    const code = opsView[r];
    const index = idxView[r];
    if (code === OP_KEEP) {
      ops.push({ op: 'keep', token: tokenTable[idsA[index]] });
    } else if (code === OP_INSERT) {
      ops.push({ op: 'insert', token: tokenTable[idsB[index]] });
    } else if (code === OP_DELETE) {
      ops.push({ op: 'delete', token: tokenTable[idsA[index]] });
    }
  }
  return ops;
}

const WASM_PAGE_SIZE = 65536;

/**
 * Grow exported WASM linear memory so at least `bytesNeeded` are addressable.
 * @param {WebAssembly.Memory} memory
 * @param {number} bytesNeeded
 * @param {number | undefined} maxBytes optional JS-side cap (embedder guardrail)
 */
function ensureWasmMemory(memory, bytesNeeded, maxBytes) {
  if (maxBytes != null && bytesNeeded > maxBytes) {
    throw new RangeError(
      `arena-diff: input requires ${bytesNeeded} bytes of WASM memory, ` +
        `but maxMemoryBytes is ${maxBytes}`,
    );
  }
  let current = memory.buffer.byteLength;
  if (bytesNeeded <= current) {
    return;
  }
  const pageTarget = Math.ceil(bytesNeeded / WASM_PAGE_SIZE) * WASM_PAGE_SIZE;
  const target =
    maxBytes != null ? Math.min(pageTarget, maxBytes) : pageTarget;
  const pages = (target - current) / WASM_PAGE_SIZE;
  if (pages <= 0) {
    return;
  }
  if (memory.grow(pages) === -1) {
    throw new RangeError(
      `arena-diff: WASM memory.grow failed — input needs ${bytesNeeded} bytes ` +
        `(~${Math.ceil(bytesNeeded / WASM_PAGE_SIZE)} pages); check runtime / module limits`,
    );
  }
}

/**
 * Decode a base64 string to bytes in any JS runtime (Node, browser, Deno, Bun,
 * edge). No `node:fs`, no `fetch`, no separate asset — works after a plain
 * `npm install` everywhere, including bundled browser builds.
 * @param {string} b64
 * @returns {Uint8Array}
 */
function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Instantiate the WASM engine. Uses the inlined binary by default; an explicit
 * binary (ArrayBuffer / typed array) can be supplied to override it.
 * @param {BufferSource} [wasmBinary]
 */
async function loadWasm(wasmBinary) {
  const bytes = wasmBinary ?? base64ToBytes(wasmBase64);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports;
}

export class ArenaDiff {
  /**
   * @param {{ wasmBinary?: BufferSource, maxMemoryBytes?: number }} [options]
   */
  constructor(options) {
    /** @type {BufferSource | undefined} optional override for the inlined WASM */
    this.wasmBinary = options?.wasmBinary;
    this.maxMemoryBytes = options?.maxMemoryBytes;
    /** @type {Awaited<ReturnType<typeof loadWasm>> | null} */
    this.exports = null;
    this.interner = new StringInterner();
    /** @type {number | undefined} bytes allocated by last compare() */
    this.lastArenaBytes = undefined;
  }

  async init() {
    if (!this.exports) {
      this.exports = await loadWasm(this.wasmBinary);
    }
    return this;
  }

  /**
   * Exact O(N+M) arena size for a token pair (same as WASM `arena_bytes`).
   * @param {number} tokenCountA
   * @param {number} tokenCountB
   */
  async estimateArenaBytes(tokenCountA, tokenCountB) {
    await this.init();
    return this.exports.arena_bytes(tokenCountA, tokenCountB);
  }

  /**
   * Compare two texts and return a structured diff.
   * Counts are eager; `ops` is materialized lazily on first access.
   * @param {string} textA
   * @param {string} textB
   */
  async compare(textA, textB) {
    await this.init();

    this.interner.reset();
    const idsA = textToIds(textA, this.interner);
    const idsB = textToIds(textB, this.interner);

    const {
      arena_bytes,
      alloc_arena,
      get_tokens_a_ptr,
      get_tokens_b_ptr,
      run_diff,
      get_result_ops_ptr,
      get_result_indices_ptr,
      get_result_keep_count,
      get_result_insert_count,
      get_result_delete_count,
      memory,
    } = this.exports;

    const n = idsA.length;
    const m = idsB.length;
    const bytesNeeded = arena_bytes(n, m);
    ensureWasmMemory(memory, bytesNeeded, this.maxMemoryBytes);

    this.lastArenaBytes = alloc_arena(n, m);

    const ptrA = get_tokens_a_ptr() >>> 2;
    const ptrB = get_tokens_b_ptr() >>> 2;

    const heap32 = new Int32Array(memory.buffer);
    heap32.set(idsA, ptrA);
    heap32.set(idsB, ptrB);

    const resultLen = run_diff();

    const keepCount = get_result_keep_count();
    const insertCount = get_result_insert_count();
    const deleteCount = get_result_delete_count();

    const opsBytePtr = get_result_ops_ptr();
    const idxBytePtr = get_result_indices_ptr();
    const memBuf = memory.buffer;
    const opsView = new Int8Array(memBuf, opsBytePtr, resultLen);
    const idxView = new Int32Array(memBuf, idxBytePtr, resultLen);

    // Snapshot WASM output into JS-owned buffers so results stay valid across
    // later compare() calls and memory.grow() (which detaches the old buffer).
    const opsSnapshot = new Int8Array(resultLen);
    opsSnapshot.set(opsView);
    const idxSnapshot = new Int32Array(resultLen);
    idxSnapshot.set(idxView);

    const tokenTable = snapshotTokenTable(idsA, idsB, this.interner);
    const wasmViews = {
      opsView: opsSnapshot,
      idxView: idxSnapshot,
      idsA,
      idsB,
      tokenTable,
      resultLen,
    };
    let cachedOps = null;

    return {
      keepCount,
      insertCount,
      deleteCount,
      get ops() {
        if (cachedOps === null) {
          cachedOps = hydrateOpsFromViews(
            opsSnapshot,
            idxSnapshot,
            idsA,
            idsB,
            tokenTable,
            resultLen,
          );
        }
        return cachedOps;
      },
      _wasmViews: wasmViews,
    };
  }
}
/**
 * Escape text for safe inclusion in XML.
 * @param {string} text
 */
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build TEI P5 inline markup from a diff op sequence.
 * Adjacent delete(s) followed by insert(s) are wrapped in `<subst>`.
 * @param {Array<{ op: string, token: string }>} ops
 */
function teiMarkupFromOps(ops) {
  let xml = '';
  for (let i = 0; i < ops.length; i++) {
    const { op, token } = ops[i];
    if (op === 'keep') {
      xml += escapeXml(token);
      continue;
    }
    if (op === 'delete') {
      const dels = [token];
      let j = i + 1;
      while (j < ops.length && ops[j].op === 'delete') {
        dels.push(ops[j].token);
        j++;
      }
      const adds = [];
      while (j < ops.length && ops[j].op === 'insert') {
        adds.push(ops[j].token);
        j++;
      }
      if (adds.length > 0) {
        xml += '<subst>';
        for (const d of dels) {
          xml += `<del>${escapeXml(d)}</del>`;
        }
        for (const a of adds) {
          xml += `<add>${escapeXml(a)}</add>`;
        }
        xml += '</subst>';
        i = j - 1;
      } else {
        xml += `<del>${escapeXml(token)}</del>`;
      }
      continue;
    }
    if (op === 'insert') {
      xml += `<add>${escapeXml(token)}</add>`;
    }
  }
  return xml;
}

/**
 * @param {Int8Array} opsView
 * @param {Int32Array} idxView
 * @param {Int32Array} idsA
 * @param {Int32Array} idsB
 * @param {string[]} tokenTable
 * @param {number} resultLen
 */
function opsArrayFromViews(opsView, idxView, idsA, idsB, tokenTable, resultLen) {
  const ops = [];
  for (let r = 0; r < resultLen; r++) {
    const code = opsView[r];
    const index = idxView[r];
    if (code === OP_KEEP) {
      ops.push({ op: 'keep', token: tokenTable[idsA[index]] });
    } else if (code === OP_INSERT) {
      ops.push({ op: 'insert', token: tokenTable[idsB[index]] });
    } else if (code === OP_DELETE) {
      ops.push({ op: 'delete', token: tokenTable[idsA[index]] });
    }
  }
  return ops;
}

/**
 * Render a diff result as TEI P5 markup (`<add>`, `<del>`, `<subst>`).
 * @param {{ ops: Array<{ op: string, token: string }>, _wasmViews?: object }} result
 * @param {{ wrapDocument?: boolean, title?: string }} [options]
 */
export function toTeiDiff(result, options = {}) {
  const { wrapDocument = false, title = 'Diff' } = options;
  const views = result._wasmViews;

  const ops = views
    ? opsArrayFromViews(
        views.opsView,
        views.idxView,
        views.idsA,
        views.idsB,
        views.tokenTable,
        views.resultLen,
      )
    : result.ops;

  const body = teiMarkupFromOps(ops);

  if (!wrapDocument) {
    return body;
  }

  const safeTitle = escapeXml(title);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<TEI xmlns="http://www.tei-c.org/ns/1.0">\n' +
    '<teiHeader>\n' +
    '<fileDesc>\n' +
    `<titleStmt><title>${safeTitle}</title></titleStmt>\n` +
    '</fileDesc>\n' +
    '</teiHeader>\n' +
    '<text>\n' +
    '<body>\n' +
    `<p>${body}</p>\n` +
    '</body>\n' +
    '</text>\n' +
    '</TEI>\n'
  );
}

/**
 * @param {{ ops: Array<{ op: string, token: string }> }} result
 */
export function serializeDiff(result) {
  return result.ops.map((o) => `${o.op}:${o.token}`).join('|');
}

/**
 * @param {string[]} tokensA
 * @param {{ ops: Array<{ op: string, token: string }>, _wasmViews?: object }} result
 */
export function applyDiff(tokensA, result) {
  const views = result._wasmViews;
  if (views) {
    const { opsView, idxView, idsB, tokenTable, resultLen } = views;
    const out = [];
    let i = 0;
    for (let r = 0; r < resultLen; r++) {
      const code = opsView[r];
      if (code === OP_KEEP) {
        out.push(tokensA[i++]);
      } else if (code === OP_DELETE) {
        i++;
      } else if (code === OP_INSERT) {
        out.push(tokenTable[idsB[idxView[r]]]);
      }
    }
    return out.join('');
  }

  const out = [];
  let i = 0;
  for (const { op, token } of result.ops) {
    if (op === 'keep') {
      out.push(tokensA[i++]);
    } else if (op === 'delete') {
      i++;
    } else if (op === 'insert') {
      out.push(token);
    }
  }
  return out.join('');
}

export { StringInterner, OP_KEEP, OP_INSERT, OP_DELETE };
