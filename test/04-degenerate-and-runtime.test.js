// 04-degenerate-and-runtime.test.js
// Degenerate edge configurations (both edges disabled), runtime requirements
// (rAF availability check), and the equality-passthrough contract on the
// timer engine's leading edge.
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { signal } from "@zakkster/lite-signal";
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

// ─── Both edges disabled: degenerate ────────────────────────────────────────

test("throttle: { leading:false, trailing:false } emits NOTHING (documented degenerate)", () => {
    const s = signal(0);
    const t = throttle(() => s(), 100, { leading: false, trailing: false });
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1); s.set(2); s.set(3);
    advance(500);                          // way past any window
    assert.deepEqual(seen, [], "degenerate config emits nothing");
    t.dispose();
});

test("throttleRAF: { leading:false, trailing:false } emits NOTHING", () => {
    const s = signal(0);
    const t = throttleRAF(() => s(), { leading: false, trailing: false });
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1); s.set(2);
    flushFrame();
    assert.deepEqual(seen, []);
    t.dispose();
});

// ─── trailing:false inside lockout drops everything ─────────────────────────

test("throttle leading-only: changes inside lockout are DROPPED (no late catch-up)", () => {
    // Distinct from 01 which tests the window-clear case; this one verifies
    // that with trailing:false, the inside-lockout writes are not queued.
    // After lockout fully expires, the LAST queued value is gone -- if a new
    // write comes after expiry it's a fresh leading; if no new write, no emit.
    const s = signal(0);
    const t = throttle(() => s(), 100, { trailing: false });
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1);                              // leading
    s.set(2); s.set(3); s.set(4);          // all dropped
    advance(200);                          // wait past lockout, no NEW writes after
    assert.deepEqual(seen, [1], "no trailing emission even after lockout fully expires");
    t.dispose();
});

test("throttleRAF leading-only: changes inside the frame are DROPPED", () => {
    const s = signal(0);
    const t = throttleRAF(() => s(), { trailing: false });
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1);                              // leading
    s.set(2); s.set(3);                    // dropped
    flushFrame();
    assert.deepEqual(seen, [1]);
    t.dispose();
});

// ─── leading:false opens window without emitting ────────────────────────────

test("throttle: leading:false + first write opens the trailing timer with that single value", () => {
    // The leading-false branch needs to still ARM the timer even when the
    // first write would have been the leading edge. Otherwise the source would
    // hang forever with no emission.
    const s = signal(0);
    const t = throttle(() => s(), 100, { leading: false });
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1);                              // no leading; opens window
    assert.deepEqual(seen, []);
    advance(100);                          // trailing fires the single value
    assert.deepEqual(seen, [1]);
    t.dispose();
});

test("throttleRAF: leading:false + first write opens a frame with that value", () => {
    const s = signal(0);
    const t = throttleRAF(() => s(), { leading: false });
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1);                              // no leading; opens frame
    assert.deepEqual(seen, []);
    flushFrame();
    assert.deepEqual(seen, [1]);
    t.dispose();
});

// ─── Output-equality dedupe on the timer engine ─────────────────────────────

test("throttle: a same-value write after lockout-expiry is short-circuited by intent guard", () => {
    const s = signal(0);
    const t = throttle(() => s(), 100);
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1);                              // leading -> output = 1
    assert.deepEqual(seen, [1], "leading emitted");
    seen.length = 0;                       // isolate the next assertion
    advance(150);                          // wait past lockout fully
    s.set(1);                              // intent guard: Object.is(1, out.peek()=1) -> short-circuit
    // Nothing happens: not a leading emit, no timer arm, no work.
    assert.deepEqual(seen, [], "post-lockout same-value write is a true no-op");
    t.dispose();
});

// ─── api shape ──────────────────────────────────────────────────────────────

test("api shape: callable, .peek, .subscribe, .dispose, .cancel, .flush all present (timer)", () => {
    const t = throttle(() => 0, 100);
    assert.equal(typeof t, "function");
    assert.equal(typeof t.peek, "function");
    assert.equal(typeof t.subscribe, "function");
    assert.equal(typeof t.dispose, "function");
    assert.equal(typeof t.cancel, "function");
    assert.equal(typeof t.flush, "function");
    t.dispose();
});

test("api shape: callable, .peek, .subscribe, .dispose, .cancel, .flush all present (rAF)", () => {
    const t = throttleRAF(() => 0);
    assert.equal(typeof t, "function");
    assert.equal(typeof t.peek, "function");
    assert.equal(typeof t.subscribe, "function");
    assert.equal(typeof t.dispose, "function");
    assert.equal(typeof t.cancel, "function");
    assert.equal(typeof t.flush, "function");
    t.dispose();
});
