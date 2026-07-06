/*
 * arena-diff — Myers O(ND) linear-space diff engine.
 *
 * Time:  O((N+M) * D) per gap; hash anchors split similar texts so D per gap
 *        stays small. Guardrails: guided O(N+M) heuristic when no anchors and
 *        gap is huge; mass-replace on extreme length ratio; Myers on anchored
 *        gaps. Anchoring is recursive on large gaps; guided diff is enabled
 *        on every gap route.
 * Space: O(N+M) — two V arrays for the middle-snake search plus flat result
 *        buffers in a pre-allocated arena. No malloc, no recursion matrices.
 *
 * Pure integer operations on interned token IDs.
 */

#include <stdint.h>

#define OP_KEEP 0
#define OP_INSERT 1
#define OP_DELETE -1
/* Guided diff: explicit keep runs in the edit stream (Myers emits delete/insert only). */
#define OP_KEEP_RUN 2
#define OP_KEEP_RUN_LEN 3

/* Minimal libc stubs for bare wasm32 link (no wasi-libc). */
void* memset(void* s, int c, unsigned long n) {
    unsigned char* p = (unsigned char*)s;
    for (unsigned long i = 0; i < n; i++) {
        p[i] = (unsigned char)c;
    }
    return s;
}

void* memcpy(void* dst, const void* src, unsigned long n) {
    unsigned char* d = (unsigned char*)dst;
    const unsigned char* s = (const unsigned char*)src;
    for (unsigned long i = 0; i < n; i++) {
        d[i] = s[i];
    }
    return dst;
}

/* Start of bump-allocated arena (linker symbol after static data). */
extern unsigned char __heap_base;

static int32_t* arena_tokens_a;
static int32_t* arena_tokens_b;
static uint8_t* arena_result_ops;
static int32_t* arena_result_indices;
static int32_t* arena_edit_ops;
static int32_t* arena_edit_idx;
static int32_t* arena_v_fwd;      /* forward V array */
static int32_t* arena_v_bwd;      /* backward V array */
static int32_t* arena_count_a;
static int32_t* arena_count_b;
static int32_t* arena_pos_b;
static int32_t* arena_anchor_i;
static int32_t* arena_anchor_j;
static int32_t* arena_lis_tails;
static int32_t* arena_lis_tail_pos;
static int32_t* arena_lis_pred;
static int32_t arena_n;
static int32_t arena_m;
static int32_t arena_result_len;
static int32_t edit_count;
static int32_t arena_edit_cap;
static int32_t edit_overflow;
static int32_t arena_keep_count;
static int32_t arena_insert_count;
static int32_t arena_delete_count;

#define ALIGN4(x) (((x) + 3) & ~3)

/* Below this token count, skip anchoring and run Myers directly. */
#define ANCHOR_THRESHOLD 64
#define HASH_WIN 16
#define HASH_STEP 8
#define HASH_SLOTS 4096

/* Gap-routing thresholds for guided diff and mass-replace guardrails. */
#define QUICK_DIFF_THRESHOLD 64
#define HUGE_DIFF_THRESHOLD 256
#define GUIDED_LOOKAHEAD 10
#define GUIDED_CORRIDOR 10
#define GUIDED_STALL_LIMIT 50
#define EXTREME_RATIO 100
#define EXTREME_MIN_TOKENS 500

static int32_t max2(int32_t a, int32_t b) {
    return a > b ? a : b;
}

static int32_t min2(int32_t a, int32_t b) {
    return a < b ? a : b;
}

static void emit_edit(int32_t op, int32_t idx) {
    if (edit_count >= arena_edit_cap) {
        edit_overflow = 1;
        return;
    }
    arena_edit_ops[edit_count] = op;
    arena_edit_idx[edit_count] = idx;
    edit_count++;
}

/* Record a matched run from guided_diff so merge does not invent false keeps. */
static void emit_keep_matches(int32_t abs_i, int32_t run_len) {
    if (run_len <= 0) {
        return;
    }
    if (run_len == 1) {
        emit_edit(OP_KEEP, abs_i);
        return;
    }
    arena_edit_ops[edit_count] = OP_KEEP_RUN;
    arena_edit_idx[edit_count] = abs_i;
    edit_count++;
    arena_edit_ops[edit_count] = OP_KEEP_RUN_LEN;
    arena_edit_idx[edit_count] = run_len;
    edit_count++;
}

static uint32_t window_hash(const int32_t* s, int32_t pos) {
    uint32_t h = 0;
    for (int32_t k = 0; k < HASH_WIN; k++) {
        h = h * 131u + (uint32_t)s[pos + k];
    }
    return h;
}

static int32_t window_equal(const int32_t* a, int32_t ia, const int32_t* b, int32_t ib) {
    for (int32_t k = 0; k < HASH_WIN; k++) {
        if (a[ia + k] != b[ib + k]) {
            return 0;
        }
    }
    return 1;
}

/* LIS on out_j (out_i already sorted by A). Returns new length. */
static int32_t lis_filter_anchors(int32_t* out_i, int32_t* out_j, int32_t num) {
    if (num <= 1) {
        return num;
    }

    int32_t* tails = arena_lis_tails;
    int32_t* tail_pos = arena_lis_tail_pos;
    int32_t* pred = arena_lis_pred;
    /* Scratch must not overlap arena_edit_ops (edits may be in flight during recursion). */
    int32_t* tmp_i = arena_count_b;
    int32_t* tmp_j = arena_pos_b;

    int32_t len = 0;
    for (int32_t p = 0; p < num; p++) {
        int32_t j = out_j[p];
        int32_t lo = 0;
        int32_t hi = len;
        while (lo < hi) {
            int32_t mid = (lo + hi) >> 1;
            if (tails[mid] < j) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        pred[p] = (lo > 0) ? tail_pos[lo - 1] : -1;
        tails[lo] = j;
        tail_pos[lo] = p;
        if (lo == len) {
            len++;
        }
    }

    int32_t k = tail_pos[len - 1];
    for (int32_t i = len - 1; i >= 0; i--) {
        tmp_i[i] = out_i[k];
        tmp_j[i] = out_j[k];
        k = pred[k];
    }
    for (int32_t i = 0; i < len; i++) {
        out_i[i] = tmp_i[i];
        out_j[i] = tmp_j[i];
    }
    return len;
}

/*
 * Rolling-hash window anchors: match HASH_WIN-token chunks between A and B,
 * then LIS to pick a monotonic chain. Works when repeated tokens defeat
 * patience-diff uniqueness (common in natural language).
 */
static int32_t find_hash_anchors(const int32_t* a, int32_t n, const int32_t* b, int32_t m,
                                 int32_t* out_i, int32_t* out_j) {
    if (n < HASH_WIN || m < HASH_WIN) {
        return 0;
    }

    int32_t* htab = arena_count_a;
    for (int32_t s = 0; s < HASH_SLOTS; s++) {
        htab[s] = -1;
    }

    for (int32_t i = 0; i <= n - HASH_WIN; i += HASH_STEP) {
        uint32_t h = window_hash(a, i) & (HASH_SLOTS - 1);
        if (htab[h] < 0) {
            htab[h] = i;
        }
    }

    int32_t num = 0;
    for (int32_t j = 0; j <= m - HASH_WIN; j += HASH_STEP) {
        uint32_t h = window_hash(b, j) & (HASH_SLOTS - 1);
        int32_t i = htab[h];
        if (i >= 0 && window_equal(a, i, b, j)) {
            out_i[num] = i;
            out_j[num] = j;
            num++;
        }
    }

    if (num <= 1) {
        return num;
    }
    return lis_filter_anchors(out_i, out_j, num);
}

static void myers_rec(const int32_t* a, int32_t n, const int32_t* b, int32_t m, int32_t i0,
                      int32_t j0);
static void process_gap(const int32_t* a, int32_t n, const int32_t* b, int32_t m, int32_t i0,
                        int32_t j0, int32_t allow_guided);
static void anchored_myers(const int32_t* a, int32_t n, const int32_t* b, int32_t m, int32_t i0,
                           int32_t j0);

static void emit_all_deletes(const int32_t* a, int32_t n, int32_t i0) {
    for (int32_t i = 0; i < n; i++) {
        emit_edit(OP_DELETE, i0 + i);
    }
    (void)a;
}

static void emit_all_inserts(const int32_t* b, int32_t m, int32_t j0) {
    for (int32_t j = 0; j < m; j++) {
        emit_edit(OP_INSERT, j0 + j);
    }
    (void)b;
}

static void mass_replace(const int32_t* a, int32_t n, const int32_t* b, int32_t m, int32_t i0,
                         int32_t j0) {
    emit_all_deletes(a, n, i0);
    emit_all_inserts(b, m, j0);
}

static int32_t is_token_rare(int32_t tok, const int32_t* s, int32_t start, int32_t end,
                             int32_t max_count) {
    int32_t count = 0;
    for (int32_t i = start; i < end; i++) {
        if (s[i] == tok) {
            count++;
            if (count > max_count) {
                return 0;
            }
        }
    }
    return count <= max_count;
}

/*
 * Heuristic greedy diff for large gaps. Not necessarily minimal, but O(N+M)
 * and avoids O((N+M)*D) blow-up when D is huge.
 */
static void guided_diff(const int32_t* a, int32_t n, const int32_t* b, int32_t m, int32_t i0,
                        int32_t j0) {
    int32_t u = 0;
    int32_t h = 0;
    int32_t baseline = 0;
    int32_t corridor = GUIDED_CORRIDOR;
    int32_t lookahead = GUIDED_LOOKAHEAD;
    int32_t total = n + m;

    if (total > 2000) {
        int32_t cw = total / 100;
        if (cw > corridor) {
            corridor = cw;
        }
        if (corridor > 100) {
            corridor = 100;
        }
        int32_t la = total / 200;
        if (la > lookahead) {
            lookahead = la;
        }
        if (lookahead > 50) {
            lookahead = 50;
        }
    }

    int32_t iter = 0;
    int32_t progress_at = 0;
    int32_t progress_u = 0;
    int32_t progress_h = 0;
    int32_t stall_limit = GUIDED_STALL_LIMIT;
    if (total > 2000) {
        int32_t sl = total / 10;
        if (sl > stall_limit) {
            stall_limit = sl;
        }
    }

    while (u < n || h < m) {
        iter++;

        if (iter - progress_at > stall_limit && u == progress_u && h == progress_h) {
            emit_all_deletes(a + u, n - u, i0 + u);
            emit_all_inserts(b + h, m - h, j0 + h);
            return;
        }
        if (u > progress_u || h > progress_h) {
            progress_at = iter;
            progress_u = u;
            progress_h = h;
        }

        if (u < n && h < m && a[u] == b[h]) {
            int32_t run_start = u;
            while (u < n && h < m && a[u] == b[h]) {
                u++;
                h++;
            }
            emit_keep_matches(i0 + run_start, u - run_start);
            continue;
        }
        if (u >= n) {
            emit_edit(OP_INSERT, j0 + h);
            h++;
            continue;
        }
        if (h >= m) {
            emit_edit(OP_DELETE, i0 + u);
            u++;
            continue;
        }

        int32_t drift = h - u - baseline;
        if (drift > corridor || drift < -corridor) {
            if (drift > 0) {
                emit_edit(OP_DELETE, i0 + u);
                u++;
            } else {
                emit_edit(OP_INSERT, j0 + h);
                h++;
            }
            continue;
        }

        int32_t tok_a = a[u];
        int32_t tok_b = b[h];
        int32_t found_b = -1;
        int32_t lim_b = h + lookahead;
        if (lim_b > m) {
            lim_b = m;
        }
        for (int32_t k = h + 1; k < lim_b; k++) {
            if (b[k] == tok_a) {
                found_b = k;
                break;
            }
        }

        int32_t found_a = -1;
        int32_t lim_a = u + lookahead;
        if (lim_a > n) {
            lim_a = n;
        }
        for (int32_t k = u + 1; k < lim_a; k++) {
            if (a[k] == tok_b) {
                found_a = k;
                break;
            }
        }

        if (found_b >= 0 && found_a < 0) {
            emit_edit(OP_INSERT, j0 + h);
            h++;
            continue;
        }
        if (found_a >= 0 && found_b < 0) {
            emit_edit(OP_DELETE, i0 + u);
            u++;
            continue;
        }
        if (found_a >= 0 && found_b >= 0) {
            int32_t cost_ins = found_b - h;
            int32_t cost_del = found_a - u;
            if (cost_ins < cost_del) {
                emit_edit(OP_INSERT, j0 + h);
                h++;
            } else {
                emit_edit(OP_DELETE, i0 + u);
                u++;
            }
            continue;
        }

        if (is_token_rare(tok_a, a, u, n, 3) && !is_token_rare(tok_b, b, h, m, 3)) {
            emit_edit(OP_INSERT, j0 + h);
            h++;
            continue;
        }
        if (is_token_rare(tok_b, b, h, m, 3) && !is_token_rare(tok_a, a, u, n, 3)) {
            emit_edit(OP_DELETE, i0 + u);
            u++;
            continue;
        }

        if (n - u > m - h) {
            emit_edit(OP_DELETE, i0 + u);
            u++;
        } else {
            emit_edit(OP_INSERT, j0 + h);
            h++;
        }
    }
}

/*
 * Route a gap to the appropriate algorithm based on size and similarity.
 */
static void process_gap(const int32_t* a, int32_t n, const int32_t* b, int32_t m, int32_t i0,
                        int32_t j0, int32_t allow_guided) {
    if (n == 0 && m == 0) {
        return;
    }
    if (n == 0) {
        emit_all_inserts(b, m, j0);
        return;
    }
    if (m == 0) {
        emit_all_deletes(a, n, i0);
        return;
    }

    int32_t d = n + m;
    int32_t ratio = 0;
    if (n > 0 && m > 0) {
        ratio = n > m ? n / m : m / n;
    }
    if (ratio > EXTREME_RATIO && d > EXTREME_MIN_TOKENS) {
        mass_replace(a, n, b, m, i0, j0);
        return;
    }
    if (allow_guided && d > HUGE_DIFF_THRESHOLD) {
        int32_t pre = 0;
        while (pre < n && pre < m && a[pre] == b[pre]) {
            pre++;
        }
        int32_t suf = 0;
        while (suf < n - pre && suf < m - pre && a[n - 1 - suf] == b[m - 1 - suf]) {
            suf++;
        }
        if (pre + suf > d / 4) {
            myers_rec(a + pre, n - pre - suf, b + pre, m - pre - suf, i0 + pre, j0 + pre);
            return;
        }
        guided_diff(a, n, b, m, i0, j0);
        return;
    }
    myers_rec(a, n, b, m, i0, j0);
}

/*
 * Hash-anchor split (recursive). Gaps route through process_gap with guided
 * fallback enabled on large unmatched regions.
 */
static void anchored_myers(const int32_t* a, int32_t n, const int32_t* b, int32_t m, int32_t i0,
                           int32_t j0) {
    if (n == 0 && m == 0) {
        return;
    }
    if (n == 0) {
        for (int32_t j = 0; j < m; j++) {
            emit_edit(OP_INSERT, j0 + j);
        }
        return;
    }
    if (m == 0) {
        for (int32_t i = 0; i < n; i++) {
            emit_edit(OP_DELETE, i0 + i);
        }
        return;
    }

    if (n + m <= ANCHOR_THRESHOLD) {
        process_gap(a, n, b, m, i0, j0, 1);
        return;
    }

    int32_t num = find_hash_anchors(a, n, b, m, arena_anchor_i, arena_anchor_j);
    if (num == 0) {
        process_gap(a, n, b, m, i0, j0, 1);
        return;
    }

    int32_t prev_i = 0;
    int32_t prev_j = 0;
    for (int32_t t = 0; t <= num; t++) {
        int32_t end_i = (t < num) ? arena_anchor_i[t] : n;
        int32_t end_j = (t < num) ? arena_anchor_j[t] : m;
        int32_t gap_n = end_i - prev_i;
        int32_t gap_m = end_j - prev_j;
        if (gap_n > 0 || gap_m > 0) {
            if (gap_n + gap_m > ANCHOR_THRESHOLD) {
                anchored_myers(a + prev_i, gap_n, b + prev_j, gap_m, i0 + prev_i, j0 + prev_j);
            } else {
                process_gap(a + prev_i, gap_n, b + prev_j, gap_m, i0 + prev_i, j0 + prev_j, 1);
            }
        }
        if (t < num) {
            prev_i = end_i + HASH_WIN;
            prev_j = end_j + HASH_WIN;
        }
    }
}

/*
 * Myers linear-space divide and conquer ("An O(ND) Difference Algorithm and
 * Its Variations", section 4b). Finds the middle snake of the shortest edit
 * script for a[0..n) vs b[0..m), then recurses on the two halves.
 *
 * Emits DELETE/INSERT edits in left-to-right order (monotone in both
 * sequences); matches (KEEP) are implicit and reconstructed afterwards.
 * i0/j0 are the absolute offsets of this slice in the original sequences.
 */
static void myers_rec(const int32_t* a, int32_t n, const int32_t* b, int32_t m, int32_t i0,
                      int32_t j0) {
    /* M4: trim matching prefix/suffix inside each gap before middle-snake work. */
    while (n > 0 && m > 0 && a[0] == b[0]) {
        a++;
        b++;
        i0++;
        j0++;
        n--;
        m--;
    }
    while (n > 0 && m > 0 && a[n - 1] == b[m - 1]) {
        n--;
        m--;
    }

    if (n == 0 && m == 0) {
        return;
    }
    if (n == 0) {
        for (int32_t j = 0; j < m; j++) {
            emit_edit(OP_INSERT, j0 + j);
        }
        return;
    }
    if (m == 0) {
        for (int32_t i = 0; i < n; i++) {
            emit_edit(OP_DELETE, i0 + i);
        }
        return;
    }

    if (n > 0 && m > 0) {
        int32_t total = n + m;
        int32_t w = n - m;
        /* Flat V indexing: diagonal k = x-y ranges in [-m, n]; slot = k + m. */
        int32_t off = m;
        int32_t vlen = n + m + 1;
        int32_t* vf = arena_v_fwd;
        int32_t* vb = arena_v_bwd;
        for (int32_t q = 0; q < vlen; q++) {
            vf[q] = 0;
            vb[q] = 0;
        }

        int32_t hmax = (total + 1) / 2;
        for (int32_t h = 0; h <= hmax; h++) {
            for (int32_t r = 0; r < 2; r++) {
                int32_t* c;
                int32_t* d;
                int32_t o;
                if (r == 0) {
                    c = vf;
                    d = vb;
                    o = 1; /* forward pass */
                } else {
                    c = vb;
                    d = vf;
                    o = 0; /* backward pass on reversed sequences */
                }
                int32_t kmin = -(h - 2 * max2(0, h - m));
                int32_t kmax = h - 2 * max2(0, h - n);
                for (int32_t k = kmin; k <= kmax; k += 2) {
                    int32_t x;
                    if (k == -h || (k != h && c[k - 1 + off] < c[k + 1 + off])) {
                        x = c[k + 1 + off];
                    } else {
                        x = c[k - 1 + off] + 1;
                    }
                    int32_t y = x - k;
                    int32_t sx = x;
                    int32_t sy = y;
                    if (o == 1) {
                        while (x < n && y < m && a[x] == b[y]) {
                            x++;
                            y++;
                        }
                    } else {
                        while (x < n && y < m && a[n - x - 1] == b[m - y - 1]) {
                            x++;
                            y++;
                        }
                    }
                    c[k + off] = x;

                    int32_t zk = -(k - w);
                    if ((total % 2) == o && zk >= -(h - o) && zk <= h - o &&
                        c[k + off] + d[zk + off] >= n) {
                        /* Middle snake found: split and recurse. */
                        int32_t depth, px, py, pu, pv;
                        if (o == 1) {
                            depth = 2 * h - 1;
                            px = sx;
                            py = sy;
                            pu = x;
                            pv = y;
                        } else {
                            depth = 2 * h;
                            px = n - x;
                            py = m - y;
                            pu = n - sx;
                            pv = m - sy;
                        }
                        if (depth > 1 || (px != pu && py != pv)) {
                            myers_rec(a, px, b, py, i0, j0);
                            myers_rec(a + pu, n - pu, b + pv, m - pv, i0 + pu, j0 + pv);
                        } else if (m > n) {
                            /* Single trailing insertion: b[n..m) after matched prefix. */
                            for (int32_t q = n; q < m; q++) {
                                emit_edit(OP_INSERT, j0 + q);
                            }
                        } else if (m < n) {
                            for (int32_t q = m; q < n; q++) {
                                emit_edit(OP_DELETE, i0 + q);
                            }
                        }
                        return;
                    }
                }
            }
        }
    }
}

static int32_t compute_arena_bytes(int32_t n, int32_t m) {
    int32_t v_words = n + m + 1;
    int32_t count_words = n + m + 2;
    int32_t anchor_words = n > m ? n : m;
    /* Guided explicit keeps: up to 2 edit slots per matched run. */
    int32_t edit_words = 2 * (n + m);
    int32_t offset = 0;

    offset = ALIGN4(offset);
    offset += (int32_t)(n * sizeof(int32_t));

    offset = ALIGN4(offset);
    offset += (int32_t)(m * sizeof(int32_t));

    offset = ALIGN4(offset);
    offset += (int32_t)((n + m) * sizeof(uint8_t));

    offset = ALIGN4(offset);
    offset += (int32_t)((n + m) * sizeof(int32_t));

    offset = ALIGN4(offset);
    offset += (int32_t)(edit_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    offset += (int32_t)(edit_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    offset += (int32_t)(v_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    offset += (int32_t)(v_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    offset += (int32_t)(count_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    offset += (int32_t)(count_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    offset += (int32_t)(count_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    offset += (int32_t)(anchor_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    offset += (int32_t)(anchor_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    offset += (int32_t)(anchor_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    offset += (int32_t)(anchor_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    offset += (int32_t)(anchor_words * sizeof(int32_t));

    return offset;
}

__attribute__((export_name("arena_bytes")))
int32_t arena_bytes(int32_t n, int32_t m) {
    return compute_arena_bytes(n, m);
}

__attribute__((export_name("alloc_arena")))
int32_t alloc_arena(int32_t n, int32_t m) {
    int32_t v_words = n + m + 1;
    int32_t count_words = n + m + 2;
    int32_t anchor_words = n > m ? n : m;
    int32_t edit_words = 2 * (n + m);
    int32_t offset = 0;
    uint8_t* base = (uint8_t*)&__heap_base;

    arena_n = n;
    arena_m = m;
    arena_result_len = 0;

    offset = ALIGN4(offset);
    arena_tokens_a = (int32_t*)(base + offset);
    offset += (int32_t)(n * sizeof(int32_t));

    offset = ALIGN4(offset);
    arena_tokens_b = (int32_t*)(base + offset);
    offset += (int32_t)(m * sizeof(int32_t));

    offset = ALIGN4(offset);
    arena_result_ops = (uint8_t*)(base + offset);
    offset += (int32_t)((n + m) * sizeof(uint8_t));

    offset = ALIGN4(offset);
    arena_result_indices = (int32_t*)(base + offset);
    offset += (int32_t)((n + m) * sizeof(int32_t));

    /* Edit stream: Myers delete/insert + guided explicit keep runs (2 slots per run). */
    offset = ALIGN4(offset);
    arena_edit_ops = (int32_t*)(base + offset);
    offset += (int32_t)(edit_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    arena_edit_idx = (int32_t*)(base + offset);
    offset += (int32_t)(edit_words * sizeof(int32_t));

    arena_edit_cap = edit_words;
    edit_overflow = 0;

    offset = ALIGN4(offset);
    arena_v_fwd = (int32_t*)(base + offset);
    offset += (int32_t)(v_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    arena_v_bwd = (int32_t*)(base + offset);
    offset += (int32_t)(v_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    arena_count_a = (int32_t*)(base + offset);
    offset += (int32_t)(count_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    arena_count_b = (int32_t*)(base + offset);
    offset += (int32_t)(count_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    arena_pos_b = (int32_t*)(base + offset);
    offset += (int32_t)(count_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    arena_anchor_i = (int32_t*)(base + offset);
    offset += (int32_t)(anchor_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    arena_anchor_j = (int32_t*)(base + offset);
    offset += (int32_t)(anchor_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    arena_lis_tails = (int32_t*)(base + offset);
    offset += (int32_t)(anchor_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    arena_lis_tail_pos = (int32_t*)(base + offset);
    offset += (int32_t)(anchor_words * sizeof(int32_t));

    offset = ALIGN4(offset);
    arena_lis_pred = (int32_t*)(base + offset);
    offset += (int32_t)(anchor_words * sizeof(int32_t));

    return compute_arena_bytes(n, m);
}

__attribute__((export_name("get_tokens_a_ptr")))
int32_t get_tokens_a_ptr(void) {
    return (int32_t)(intptr_t)arena_tokens_a;
}

__attribute__((export_name("get_tokens_b_ptr")))
int32_t get_tokens_b_ptr(void) {
    return (int32_t)(intptr_t)arena_tokens_b;
}

static void myers_fallback_slice(int32_t pre, int32_t suf, int32_t n, int32_t m) {
    const int32_t* a = arena_tokens_a;
    const int32_t* b = arena_tokens_b;
    edit_count = 0;
    edit_overflow = 0;
    myers_rec(a + pre, n - pre - suf, b + pre, m - pre - suf, pre, pre);
}

/* Net delete/insert count must match length delta (valid transform A → B). */
static int32_t edit_script_balanced(int32_t n, int32_t m) {
    int32_t del = 0;
    int32_t ins = 0;
    for (int32_t t = 0; t < edit_count; t++) {
        int32_t op = arena_edit_ops[t];
        if (op == OP_DELETE) {
            del++;
        } else if (op == OP_INSERT) {
            ins++;
        } else if (op == OP_KEEP_RUN) {
            t++;
        }
    }
    return (del - ins) == (n - m);
}

__attribute__((export_name("run_diff")))
int32_t run_diff(void) {
    const int32_t* a = arena_tokens_a;
    const int32_t* b = arena_tokens_b;
    int32_t n = arena_n;
    int32_t m = arena_m;

    /* Trim common prefix and suffix — O(N+M), shrinks the Myers problem. */
    int32_t pre = 0;
    while (pre < n && pre < m && a[pre] == b[pre]) {
        pre++;
    }
    int32_t suf = 0;
    while (suf < n - pre && suf < m - pre && a[n - 1 - suf] == b[m - 1 - suf]) {
        suf++;
    }

    edit_count = 0;
    edit_overflow = 0;
    anchored_myers(a + pre, n - pre - suf, b + pre, m - pre - suf, pre, pre);

    /*
     * Guided/heuristic gaps can emit an imbalanced script on hard inputs; fall back
     * to optimal Myers on the trimmed slice (correct, bounded memory).
     */
    if (edit_overflow || !edit_script_balanced(n, m)) {
        myers_fallback_slice(pre, suf, n, m);
    }

    /*
     * Merge pass: Myers emits delete/insert only (implicit keeps between edits).
     * Guided diff also emits explicit OP_KEEP / OP_KEEP_RUN entries.
     */
    uint8_t* ops = arena_result_ops;
    int32_t* idx = arena_result_indices;
    int32_t i = 0;
    int32_t j = 0;
    int32_t pos = 0;
    int32_t keep_c = 0;
    int32_t ins_c = 0;
    int32_t del_c = 0;

    for (int32_t t = 0; t < edit_count; t++) {
        int32_t op = arena_edit_ops[t];
        int32_t p = arena_edit_idx[t];

        if (op == OP_KEEP_RUN_LEN) {
            continue;
        }

        if (op == OP_KEEP_RUN) {
            int32_t start = p;
            int32_t run_len = arena_edit_idx[t + 1];
            int32_t run_end = start + run_len;
            t++;
            if (i >= run_end) {
                continue;
            }
            while (i < start) {
                ops[pos] = (uint8_t)OP_KEEP;
                idx[pos] = i;
                pos++;
                i++;
                j++;
                keep_c++;
            }
            for (int32_t pos_a = i; pos_a < run_end; pos_a++) {
                ops[pos] = (uint8_t)OP_KEEP;
                idx[pos] = pos_a;
                pos++;
                keep_c++;
            }
            j += run_end - i;
            i = run_end;
            continue;
        }

        if (op == OP_KEEP) {
            if (i > p) {
                continue;
            }
            while (i < p) {
                ops[pos] = (uint8_t)OP_KEEP;
                idx[pos] = i;
                pos++;
                i++;
                j++;
                keep_c++;
            }
            ops[pos] = (uint8_t)OP_KEEP;
            idx[pos] = p;
            pos++;
            i = p + 1;
            j++;
            keep_c++;
            continue;
        }

        if (op == OP_DELETE) {
            while (i < p && i < n && j < m) {
                ops[pos] = (uint8_t)OP_KEEP;
                idx[pos] = i;
                pos++;
                i++;
                j++;
                keep_c++;
            }
            if (i >= n) {
                continue;
            }
            ops[pos] = (uint8_t)OP_DELETE;
            idx[pos] = i;
            pos++;
            i++;
            del_c++;
        } else {
            while (j < p && i < n && j < m) {
                ops[pos] = (uint8_t)OP_KEEP;
                idx[pos] = i;
                pos++;
                i++;
                j++;
                keep_c++;
            }
            if (j >= m) {
                continue;
            }
            ops[pos] = (uint8_t)OP_INSERT;
            idx[pos] = j;
            pos++;
            j++;
            ins_c++;
        }
    }
    while (i < n && j < m) {
        ops[pos] = (uint8_t)OP_KEEP;
        idx[pos] = i;
        pos++;
        i++;
        j++;
        keep_c++;
    }

    arena_keep_count = keep_c;
    arena_insert_count = ins_c;
    arena_delete_count = del_c;
    arena_result_len = pos;
    return pos;
}

__attribute__((export_name("get_result_ops_ptr")))
int32_t get_result_ops_ptr(void) {
    return (int32_t)(intptr_t)arena_result_ops;
}

__attribute__((export_name("get_result_indices_ptr")))
int32_t get_result_indices_ptr(void) {
    return (int32_t)(intptr_t)arena_result_indices;
}

__attribute__((export_name("get_result_len")))
int32_t get_result_len(void) {
    return arena_result_len;
}

__attribute__((export_name("get_result_keep_count")))
int32_t get_result_keep_count(void) {
    return arena_keep_count;
}

__attribute__((export_name("get_result_insert_count")))
int32_t get_result_insert_count(void) {
    return arena_insert_count;
}

__attribute__((export_name("get_result_delete_count")))
int32_t get_result_delete_count(void) {
    return arena_delete_count;
}
