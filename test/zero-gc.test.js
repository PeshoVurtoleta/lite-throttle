// zero-gc.test.js
// Hot-path retention contract for both engines. The library's headline
// promise is "zero JS-heap allocations from this package per source change
// in steady state". The bench (bench/benchmark.mjs, ran on user's MacBook
// Node 23) measures Δheap ≈ -3.9 KB across 100k throttle.set() calls and
// ~9 KB across 100k throttleRAF.set() calls -- both essentially zero
// (negative numbers mean GC collected more than was allocated).
//
// We assert a loose budget here (10 B/op) that decisively catches a real
// regression: a regression that allocated a closure per source change would
// land at 30-50 B/op, well over threshold. min-of-3 to absorb V8 jitter,
// same pattern as lite-raf / lite-persist / lite-element.
//
// Also: structural twin assertions that prove the *purpose* of the zero-GC
// hot path. If a burst doesn't actually coalesce, the perf claim collapses
// regardless of allocation numbers.
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { signal } from "@zakkster/lite-signal";
import { throttle, throttleRAF } from "../index.js";

const hasGc = typeof global !== "undefined" && typeof global.gc === "function";

let clk = 0;
const realPerf = globalThis.performance;
const realRAF = globalThis.requestAnimationFrame;
const realCAF = globalThis.cancelAnimationFrame;
let rafQueue = [];
let rafSeq = 1;

beforeEach(() => {
    clk = 0;
    globalThis.performance = { now: () => clk };
    mock.timers.enable({ apis: ["setTimeout"] });
    rafQueue = [];
    rafSeq = 1;
    globalThis.requestAnimationFrame = (cb) => { const id = rafSeq++; rafQueue.push([id, cb]); return id; };
    globalThis.cancelAnimationFrame = (id) => { rafQueue = rafQueue.filter(([i]) => i !== id); };
});
afterEach(() => {
    mock.timers.reset();
    globalThis.performance = realPerf;
    globalThis.requestAnimationFrame = realRAF;
    globalThis.cancelAnimationFrame = realCAF;
});

function runThrottleBurst(N) {
    const s = signal(0);
    // Long ms so the entire burst stays inside the lockout window: the
    // performance.now() / setTimeout path is NEVER walked. We measure the
    // hottest path of the timer engine: inside-lockout intent-guard + queue.
    const t = throttle(() => s(), 1_000_000);
    const sub = t.subscribe(() => {});

    // Warm V8 inlines.
    for (let i = 0; i < 5_000; i++) s.set(i);
    global.gc(); global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < N; i++) s.set(i + 1_000_000);
    global.gc(); global.gc();
    const retained = process.memoryUsage().heapUsed - before;

    sub();
    t.dispose();
    return { retained, perOp: retained / N };
}

function runThrottleRAFBurst(N) {
    const s = signal(0);
    const t = throttleRAF(() => s());
    const sub = t.subscribe(() => {});

    // Prime the lockout: first set arms the rAF. Subsequent sets are pure
    // in-frame queue updates -- zero clock read, zero rAF churn.
    s.set(-1);
    for (let i = 0; i < 5_000; i++) s.set(i);
    global.gc(); global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < N; i++) s.set(i + 1_000_000);
    global.gc(); global.gc();
    const retained = process.memoryUsage().heapUsed - before;

    sub();
    t.dispose();
    return { retained, perOp: retained / N };
}

function minOf3(fn, N) {
    let best = Infinity;
    let bestRetained = 0;
    for (let i = 0; i < 3; i++) {
        const r = fn(N);
        if (r.perOp < best) { best = r.perOp; bestRetained = r.retained; }
    }
    return { perOp: best, retained: bestRetained };
}

test("zero-GC: throttle inside-lockout burst retains < 10 B/op (min of 3, 50k sets)", { skip: !hasGc && "run with --expose-gc to enable" }, () => {
    const { perOp, retained } = minOf3(runThrottleBurst, 50_000);
    assert.ok(perOp < 10, `throttle: expected < 10 B/op retained; got ${perOp.toFixed(4)} B/op (${retained} B / 50000)`);
});

test("zero-GC: throttleRAF inside-frame burst retains < 10 B/op (min of 3, 50k sets)", { skip: !hasGc && "run with --expose-gc to enable" }, () => {
    const { perOp, retained } = minOf3(runThrottleRAFBurst, 50_000);
    assert.ok(perOp < 10, `throttleRAF: expected < 10 B/op retained; got ${perOp.toFixed(4)} B/op (${retained} B / 50000)`);
});

test("structural: 10k throttle.set() inside lockout collapse to 1 trailing emission", () => {
    const s = signal(0);
    const t = throttle(() => s(), 100);
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    for (let i = 1; i <= 10_000; i++) s.set(i);
    // Leading fires once (the first set) -> seen = [1]. Trailing fires once
    // when window expires -> seen = [1, 10000].
    assert.deepEqual(seen, [1], "exactly one emission during the burst (leading)");
    for (let i = 0; i < 100; i++) { clk++; mock.timers.tick(1); }
    assert.deepEqual(seen, [1, 10_000], "exactly one trailing emission carrying the final value");
    t.dispose();
});

test("structural: 10k throttleRAF.set() inside a frame collapse to 1 trailing emission", () => {
    const s = signal(0);
    const t = throttleRAF(() => s());
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    for (let i = 1; i <= 10_000; i++) s.set(i);
    assert.deepEqual(seen, [1], "leading only during the burst");
    const q = rafQueue; rafQueue = []; for (const [, cb] of q) cb();
    assert.deepEqual(seen, [1, 10_000], "trailing fired the final value at frame boundary");
    t.dispose();
});
