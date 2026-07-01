// bench/benchmark.mjs — comparative benchmark for @zakkster/lite-throttle.
//
// Run:  node --expose-gc bench/benchmark.mjs
//
// Methodology: 5 rounds per scenario. Median is the headline; min/max
// reported so V8 JIT tier-up variance is visible.
//
// Comparisons:
//   1. @zakkster/lite-throttle             (this package)
//   2. naive setTimeout / rAF per arm      (closure-per-arm baseline)
//   3. lodash.throttle wrapped in an effect
//
// throttleRAF requires a host requestAnimationFrame. We stub with a manual
// queue that NEVER fires during the timed loop — this isolates the in-lockout
// write path, which is the realistic hot path during a burst.

import { signal, effect } from "@zakkster/lite-signal";
import lodashThrottle from "lodash.throttle";
import { throttle, throttleRAF } from "../index.js";

if (typeof globalThis.gc !== "function") {
    console.error("This benchmark requires --expose-gc. Re-run: node --expose-gc bench/benchmark.mjs");
    process.exit(1);
}

const N = 100_000;
const MS = 10;
const WARMUP = 10_000;
const ROUNDS = 5;

let rafQueue = [];
let rafId = 1;
globalThis.requestAnimationFrame = (cb) => {
    const id = rafId++;
    rafQueue.push({ id, cb });
    return id;
};
globalThis.cancelAnimationFrame = (id) => {
    for (let i = 0; i < rafQueue.length; i++) {
        if (rafQueue[i].id === id) { rafQueue.splice(i, 1); return; }
    }
};

function forceGC() { globalThis.gc(); globalThis.gc(); }
function fmtK(n)   { return (n / 1_000).toFixed(0).padStart(6) + "K"; }
function fmtKB(n)  { return (n / 1024).toFixed(1).padStart(7); }

function measure(label, setup) {
    const ops = [];
    const heap = [];

    for (let r = 0; r < ROUNDS; r++) {
        const { write, dispose } = setup();

        for (let i = 0; i < WARMUP; i++) write(i);

        forceGC();
        const memBefore = process.memoryUsage().heapUsed;
        const t0 = process.hrtime.bigint();

        for (let i = 0; i < N; i++) write(i + 1_000_000 + r * N);

        const t1 = process.hrtime.bigint();
        forceGC();
        const memAfter = process.memoryUsage().heapUsed;

        dispose();

        ops.push((N * 1e9) / Number(t1 - t0));
        heap.push(memAfter - memBefore);
    }

    ops.sort((a, b) => a - b);
    heap.sort((a, b) => a - b);
    const mid = Math.floor(ROUNDS / 2);

    console.log(
        `  ${label.padEnd(36)} ` +
        `${fmtK(ops[mid])} ops/s  ` +
        `[${fmtK(ops[0])}..${fmtK(ops[ROUNDS - 1])}]  ` +
        `Δheap≈${fmtKB(heap[mid])} KB  ` +
        `${(heap[mid] / N).toFixed(2).padStart(6)} B/op`
    );
}

console.log(`\n  ${"".padEnd(36)}  median ops/s        min..max`);

console.log(`\nScenario: timer-based throttle, ms=${MS}, N=${N.toLocaleString()}, rounds=${ROUNDS}`);

measure("@zakkster/lite-throttle.throttle", () => {
    const src = signal(0);
    const t = throttle(() => src(), MS);
    const sink = { n: 0 };
    t.subscribe((v) => { sink.n = v; });
    return { write: (v) => src.set(v), dispose: () => t.dispose() };
});

measure("naive: effect + setTimeout closure", () => {
    const src = signal(0);
    const sink = { n: 0 };
    let timerId = null;
    let lastEmit = 0;
    let lastV;
    const dispose = effect(() => {
        lastV = src();
        const now = performance.now();
        const elapsed = now - lastEmit;
        if (elapsed >= MS && timerId === null) {
            lastEmit = now;
            sink.n = lastV;
        } else if (timerId === null) {
            timerId = setTimeout(() => {
                lastEmit = performance.now();
                sink.n = lastV;
                timerId = null;
            }, MS - elapsed);
        }
    });
    return {
        write: (v) => src.set(v),
        dispose: () => { if (timerId !== null) clearTimeout(timerId); dispose(); },
    };
});

measure("lodash.throttle wrapped in effect", () => {
    const src = signal(0);
    const sink = { n: 0 };
    const cb = lodashThrottle((v) => { sink.n = v; }, MS, { leading: true, trailing: true });
    const dispose = effect(() => cb(src()));
    return { write: (v) => src.set(v), dispose: () => { cb.cancel(); dispose(); } };
});

console.log(`\nScenario: rAF-aligned throttle (stubbed rAF, in-lockout writes), N=${N.toLocaleString()}, rounds=${ROUNDS}`);

measure("@zakkster/lite-throttle.throttleRAF", () => {
    const src = signal(0);
    const t = throttleRAF(() => src());
    const sink = { n: 0 };
    t.subscribe((v) => { sink.n = v; });
    return { write: (v) => src.set(v), dispose: () => t.dispose() };
});

measure("naive: effect + rAF closure", () => {
    const src = signal(0);
    const sink = { n: 0 };
    let queued = 0;
    let lastV;
    const dispose = effect(() => {
        lastV = src();
        if (queued === 0) {
            queued = requestAnimationFrame(() => { sink.n = lastV; queued = 0; });
        }
    });
    return {
        write: (v) => src.set(v),
        dispose: () => { if (queued !== 0) cancelAnimationFrame(queued); dispose(); },
    };
});

console.log(`
Notes:
  - 'median ops/s' over ${ROUNDS} rounds; '[min..max]' shows run-to-run JIT
    variance. V8 tier-up is non-deterministic on consumer hardware — a 2-3x
    spread between cold and hot runs is expected, not a bench bug.
  - throttle skips performance.now() entirely during the lockout window
    (timerId !== null), reading the clock only on potential leading edges.
    That's the difference vs the naive line, which reads the clock per write.
  - throttleRAF reads no clock at all and has zero timer-queue churn — its
    in-lockout path is the tightest hot path in the package.
  - The 'naive' rAF line allocates a fresh closure per frame arm; this cost
    amortizes when N writes share one frame, but a bursty source with
    frequent arm/fire cycles pays per arm.
`);
