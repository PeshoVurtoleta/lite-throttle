// 05-pending-and-dynamic-ms.test.js
// 1.2 additions:
//  - api.pending() reflects whether a trailing emission is queued
//  - throttle(ms) accepts a function for a dynamic window; the reader is
//    called via untrack, so signal changes to the window don't re-run the effect
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

function advance(ms) { for (let i = 0; i < ms; i++) { clk++; mock.timers.tick(1); } }
function flushFrame() { const q = rafQueue; rafQueue = []; for (const [, cb] of q) cb(); }

// ─── pending() ──────────────────────────────────────────────────────────────

test("throttle.pending(): false initially, true while trailing queued, false after fire", () => {
    const s = signal(0);
    const t = throttle(() => s(), 100);
    assert.equal(t.pending(), false, "no writes yet");
    s.set(1);                                          // leading, no trailing queued
    assert.equal(t.pending(), false, "leading fired, nothing pending");
    s.set(2);                                          // inside lockout -> queued trailing
    assert.equal(t.pending(), true, "trailing queued");
    s.set(3);                                          // still queued (updated value)
    assert.equal(t.pending(), true, "still queued");
    advance(100);                                      // trailing fires
    assert.equal(t.pending(), false, "flushed");
    t.dispose();
});

test("throttle.pending(): cancel clears it, flush clears it", () => {
    const s = signal(0);
    const t = throttle(() => s(), 100);
    s.set(1); s.set(2);
    assert.equal(t.pending(), true);
    t.cancel();
    assert.equal(t.pending(), false, "cancel drops pending");

    s.set(3); s.set(4);
    assert.equal(t.pending(), true);
    t.flush();
    assert.equal(t.pending(), false, "flush drops pending");
    t.dispose();
});

test("throttleRAF.pending(): tracks the in-frame queue state", () => {
    const s = signal(0);
    const t = throttleRAF(() => s());
    assert.equal(t.pending(), false);
    s.set(1);                                          // leading, no trailing queued
    assert.equal(t.pending(), false);
    s.set(2);                                          // queued
    assert.equal(t.pending(), true);
    flushFrame();
    assert.equal(t.pending(), false);
    t.dispose();
});

test("throttle: leading:false first write queues immediately -> pending() true", () => {
    const s = signal(0);
    const t = throttle(() => s(), 100, { leading: false });
    s.set(1);                                          // no leading; opens trailing window
    assert.equal(t.pending(), true, "trailing-only mode queues from the first write");
    advance(100);
    assert.equal(t.pending(), false);
    t.dispose();
});

// ─── Dynamic ms ─────────────────────────────────────────────────────────────

test("throttle: ms as a function is called only on the potential-leading branch", () => {
    // The window is read when timerId === null (either fresh, or lockout
    // fully expired). It is NOT read on the inside-lockout branch (timerId
    // !== null) and NOT read on the flush path.
    //
    // Trace for a 100ms throttle starting at clk=0:
    //   s.set(1) -- timerId null, elapsed=Inf, leading fires, reads window (1)
    //   s.set(2) -- timerId still null (no trailing armed yet), elapsed=0,
    //               takes the trailing-arm branch, reads window (2), arms timer
    //   s.set(3), s.set(4) -- timerId !== null, INSIDE LOCKOUT, no window read
    //   advance(100) -- flush() fires; no window read on flush
    //   s.set(5) -- timerId null again, reads window (3)
    let calls = 0;
    const window = () => { calls++; return 100; };
    const s = signal(0);
    const t = throttle(() => s(), window);

    assert.equal(calls, 0, "not called during construction");

    s.set(1);                                          // leading branch reads window
    assert.equal(calls, 1);

    s.set(2);                                          // timerId still null -> trailing-arm reads window
    assert.equal(calls, 2);

    s.set(3); s.set(4);                                // timerId armed -> inside-lockout hot path
    assert.equal(calls, 2, "inside-lockout writes never read the window");

    advance(100);                                      // flush path -- no window read
    assert.equal(calls, 2, "flush path doesn't read window");

    s.set(5);                                          // timerId null -> reads window again
    assert.equal(calls, 3);
    t.dispose();
});

test("throttle: dynamic ms picks up new value at the NEXT window boundary", () => {
    // The window function is consulted only when timerId === null. Once a
    // lockout is armed, its duration is fixed. Changing ms mid-lockout takes
    // effect on the NEXT time a timer needs to be armed, not the current one.
    //
    // Trace: after a trailing fire, lastEmitTime is set to now(). So an
    // immediately-following change hits timerId===null but elapsed=0 --
    // it takes the trailing-arm branch (not leading) with the new window.
    let currentMs = 100;
    const s = signal(0);
    const t = throttle(() => s(), () => currentMs);
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1);                                          // leading -> ms=100 read; no timer armed yet
    s.set(2);                                          // arms timer for 100 with pending=2
    currentMs = 20;                                    // shorten mid-lockout
    advance(100);                                      // armed timer still 100ms -> fires at clk=100
    assert.deepEqual(seen, [1, 2], "current window ran to its original 100ms");

    // clk=100, lastEmitTime=100.
    s.set(3);                                          // elapsed=0, ms=20, arms timer for 20, pending=3
    s.set(4);                                          // inside lockout, pending=4
    advance(20);                                       // clk=120, timer fires with pending=4
    assert.deepEqual(seen, [1, 2, 4], "next window used the new 20ms and flushed the latest queued value");
    t.dispose();
});

test("throttle: dynamic ms is untracked -- window signal changes don't re-run effect", () => {
    // If ms were tracked, writing to msSignal would re-run the source-reading
    // effect and potentially emit spuriously. The intent is: window is
    // configuration, not a value dependency. Consumers who want reactive
    // reconfig should dispose and rebuild.
    const s = signal(0);
    const msSig = signal(100);
    const t = throttle(() => s(), () => msSig());
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1);                                          // leading
    assert.deepEqual(seen, [1]);
    msSig.set(50);                                     // change the window
    assert.deepEqual(seen, [1], "window change did NOT trigger an emit");
    t.dispose();
});

// ─── api shape includes pending() ──────────────────────────────────────────

test("api shape: pending() present on both engines", () => {
    const t1 = throttle(() => 0, 100);
    assert.equal(typeof t1.pending, "function");
    t1.dispose();

    const t2 = throttleRAF(() => 0);
    assert.equal(typeof t2.pending, "function");
    t2.dispose();
});
