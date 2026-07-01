// 06-ownership-cascade.test.js
// 1.2 correctness fix: when the parent scope disposes (e.g. an outer effect
// re-runs or is disposed), the pending setTimeout / requestAnimationFrame
// must be cancelled and closure state cleared. Before 1.2, the reactive
// graph was released but the armed timer / rAF was left to fire against a
// torn-down downstream -- silent leak, hard-to-diagnose "why is this still
// firing" bug.
//
// The fix is a nested "cleanup holder" effect inside each throttle
// constructor. It reads no signals so it never re-runs; its onCleanup fires
// only on cascade dispose from the parent scope (or on manual api.dispose).
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { signal, effect } from "@zakkster/lite-signal";
import { throttle, throttleRAF } from "../index.js";

let clk = 0;
const realPerf = globalThis.performance;
const realRAF = globalThis.requestAnimationFrame;
const realCAF = globalThis.cancelAnimationFrame;
let rafQueue = [];
let rafSeq = 1;
let scheduledTimers = 0;
let cancelledTimers = 0;

beforeEach(() => {
    clk = 0;
    globalThis.performance = { now: () => clk };
    mock.timers.enable({ apis: ["setTimeout"] });
    rafQueue = [];
    rafSeq = 1;
    scheduledTimers = 0;
    cancelledTimers = 0;
    globalThis.requestAnimationFrame = (cb) => { const id = rafSeq++; rafQueue.push([id, cb]); return id; };
    globalThis.cancelAnimationFrame = (id) => {
        const before = rafQueue.length;
        rafQueue = rafQueue.filter(([i]) => i !== id);
        if (rafQueue.length < before) cancelledTimers++;
    };
});
afterEach(() => {
    mock.timers.reset();
    globalThis.performance = realPerf;
    globalThis.requestAnimationFrame = realRAF;
    globalThis.cancelAnimationFrame = realCAF;
});

function advance(ms) { for (let i = 0; i < ms; i++) { clk++; mock.timers.tick(1); } }
function flushFrame() { const q = rafQueue; rafQueue = []; for (const [, cb] of q) cb(); }

// ─── Cascade dispose cancels pending timer (throttle) ───────────────────────

test("throttle: parent-scope dispose cascades to timer cancel", () => {
    let armed = 0, cancelled = 0;
    const src = signal(0);                             // source lives OUTSIDE the outer effect
    let t;

    const outer = effect(() => {
        // Read a control signal so the effect exists in the reactive graph
        // but doesn't re-run when src changes.
        // (Actually we don't need to read anything -- the effect still runs
        // once and gets tracked in the ownership tree via its own creation.)
        t = throttle(() => src(), 100, {
            schedule: (fn, ms) => { armed++; return { fn, ms, id: armed }; },
            cancel: () => { cancelled++; },
            now: () => clk,
        });
    });

    // Prime: leading emit.
    src.set(1);
    assert.equal(armed, 0, "leading emit doesn't schedule -- only queues time");
    // Queue trailing.
    src.set(2);
    assert.equal(armed, 1, "trailing timer armed");
    assert.equal(cancelled, 0);

    // Dispose the OUTER effect. This should cascade to the throttle's cleanup
    // holder, which cancels the pending timer.
    outer();

    assert.equal(cancelled, 1, "cascade dispose cancelled the pending timer");

    // Further writes to src should not fire the trailing (the throttle is dead).
    src.set(3);
    assert.equal(armed, 1, "no new timer armed after cascade dispose");
});

// ─── Cascade dispose cancels pending rAF (throttleRAF) ──────────────────────

test("throttleRAF: parent-scope dispose cascades to rAF cancel", () => {
    let armedRAF = 0, cancelledRAF = 0;
    const src = signal(0);
    let t;

    const outer = effect(() => {
        t = throttleRAF(() => src(), {
            raf: (cb) => { armedRAF++; return { cb, id: armedRAF }; },
            caf: () => { cancelledRAF++; },
        });
    });

    src.set(1);                                        // leading -> arms rAF
    assert.equal(armedRAF, 1);
    assert.equal(cancelledRAF, 0);

    outer();                                           // dispose parent

    assert.equal(cancelledRAF, 1, "cascade dispose cancelled the armed rAF");

    src.set(2);
    assert.equal(armedRAF, 1, "no new rAF armed after cascade dispose");
});

// ─── Sanity: manual api.dispose still works (regression) ─────────────────────

test("throttle: api.dispose() still cancels the pending timer (no cascade involved)", () => {
    let armed = 0, cancelled = 0;
    const s = signal(0);
    const t = throttle(() => s(), 100, {
        schedule: (fn, ms) => { armed++; return { fn, ms, id: armed }; },
        cancel: () => { cancelled++; },
        now: () => clk,
    });
    s.set(1); s.set(2);                                // leading + queue trailing
    assert.equal(armed, 1);
    t.dispose();
    assert.equal(cancelled, 1, "manual dispose still cancels the timer");
});

test("throttleRAF: api.dispose() still cancels the pending rAF", () => {
    let armedRAF = 0, cancelledRAF = 0;
    const s = signal(0);
    const t = throttleRAF(() => s(), {
        raf: (cb) => { armedRAF++; return { cb, id: armedRAF }; },
        caf: () => { cancelledRAF++; },
    });
    s.set(1);
    assert.equal(armedRAF, 1);
    t.dispose();
    assert.equal(cancelledRAF, 1);
});

// ─── Sanity: dispose remains idempotent after the cascade fix ───────────────

test("throttle: dispose is still idempotent after 1.2 cleanup-holder refactor", () => {
    const s = signal(0);
    const t = throttle(() => s(), 100);
    s.set(1); s.set(2);
    assert.doesNotThrow(() => { t.dispose(); t.dispose(); t.dispose(); });
});

test("throttleRAF: dispose is still idempotent after 1.2 cleanup-holder refactor", () => {
    const s = signal(0);
    const t = throttleRAF(() => s());
    s.set(1); s.set(2);
    assert.doesNotThrow(() => { t.dispose(); t.dispose(); t.dispose(); });
});
