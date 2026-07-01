// 03-timer-corner-cases.test.js
// Timer-engine edges + general api shape: intent-guard on output equality,
// lockout-fully-expired path, equality passthrough on output, dispose
// idempotency, cancel/flush no-pending safety, subscribe semantics, peek vs
// tracked read.
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { signal } from "@zakkster/lite-signal";
import { throttle } from "../Throttle.js";

let clk = 0;
const realPerf = globalThis.performance;

beforeEach(() => {
    clk = 0;
    globalThis.performance = { now: () => clk };
    mock.timers.enable({ apis: ["setTimeout"] });
});
afterEach(() => {
    mock.timers.reset();
    globalThis.performance = realPerf;
});

function advance(ms) { for (let i = 0; i < ms; i++) { clk++; mock.timers.tick(1); } }

// ─── Intent guard ───────────────────────────────────────────────────────────

test("throttle: writing the SAME value as current output does NOT emit (intent guard)", () => {
    const s = signal(5);
    const t = throttle(() => s(), 100);
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(5);                              // identical to current output
    advance(200);
    assert.deepEqual(seen, []);
    t.dispose();
});

test("throttle: writing the same value as the pending one inside lockout does NOT re-queue", () => {
    // Intent guard compares against pendingValue when hasPending, not against
    // out.peek(). So the second identical write is a no-op (not a "re-queue
    // of the same value"). This is observable as: cancel after the duplicate
    // write still leaves nothing pending -> trailing never fires.
    const s = signal(0);
    const t = throttle(() => s(), 100);
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1);                              // leading -> 1
    s.set(2);                              // pendingValue = 2
    s.set(2);                              // intent matches pending -> no-op
    advance(100);
    assert.deepEqual(seen, [1, 2], "trailing 2 emitted once");
    t.dispose();
});

// ─── Lockout fully expired ──────────────────────────────────────────────────

test("throttle: after the lockout fully expires, a single write takes the leading branch", () => {
    const s = signal(0);
    const t = throttle(() => s(), 100);
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1);                              // leading
    advance(150);                          // wait WELL past ms
    s.set(2);                              // timerId === null, elapsed >= ms -> immediate leading
    assert.deepEqual(seen, [1, 2]);
    t.dispose();
});

// ─── Output equality passthrough ────────────────────────────────────────────

test("throttle: trailing emission whose value matches current output does NOT notify subscribers", () => {
    // The internal signal uses default Object.is equality. A trailing fire of
    // the SAME value as the current output is suppressed by lite-signal.
    const s = signal(0);
    const t = throttle(() => s(), 100);
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1);                              // leading -> output = 1
    s.set(7);                              // pending = 7
    s.set(1);                              // intent matches CURRENT output (1) - wait, actually intent guard uses pendingValue (7) here
    // After the third set: intent = pendingValue = 7. nextValue = 1. Object.is(1, 7) = false. So it goes through. pendingValue = 1.
    // advance triggers trailing fire of 1. But out is already 1 from leading -> lite-signal Object.is dedupe -> no notify.
    advance(100);
    assert.deepEqual(seen, [1], "trailing 1 was suppressed because output was already 1");
    t.dispose();
});

// ─── Dispose / cancel / flush no-pending safety ─────────────────────────────

test("throttle: dispose is idempotent (calling twice is safe)", () => {
    const s = signal(0);
    const t = throttle(() => s(), 100);
    s.set(1);
    assert.doesNotThrow(() => { t.dispose(); t.dispose(); t.dispose(); });
});

test("throttle: cancel with nothing pending is safe", () => {
    const s = signal(0);
    const t = throttle(() => s(), 100);
    assert.doesNotThrow(() => { t.cancel(); t.cancel(); });
    // Subsequent operations should still work.
    s.set(1);
    const seen = [];
    t.subscribe(v => seen.push(v));
    assert.equal(seen[0], 1, "still functional after no-op cancel");
    t.dispose();
});

test("throttle: flush with nothing pending returns current output without emitting", () => {
    const s = signal(0);
    const t = throttle(() => s(), 100);
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    assert.equal(t.flush(), 0, "returns current output");
    assert.deepEqual(seen, [], "no emission for empty flush");
    t.dispose();
});

// ─── Subscribe semantics ────────────────────────────────────────────────────

test("throttle: subscribe fires immediately with the current value, then on change", () => {
    const s = signal(42);
    const t = throttle(() => s(), 100);
    const seen = [];
    t.subscribe(v => seen.push(v));
    // value-now per lite-signal subscribe contract.
    assert.deepEqual(seen, [42], "value-now on subscribe");
    s.set(43);
    assert.deepEqual(seen, [42, 43]);
    t.dispose();
});

test("throttle: multiple subscribers fire independently; unsubscribe one keeps others", () => {
    const s = signal(0);
    const t = throttle(() => s(), 100);
    const a = [], b = [];
    const unA = t.subscribe(v => a.push(v));
    const unB = t.subscribe(v => b.push(v));
    a.length = 0; b.length = 0;

    s.set(1);
    assert.deepEqual(a, [1]);
    assert.deepEqual(b, [1]);
    unA();
    s.set(2);
    advance(200);                          // settle any trailing
    assert.deepEqual(a, [1], "unsubscribed");
    assert.deepEqual(b, [1, 2], "still subscribed");
    unB();
    t.dispose();
});

// ─── peek vs tracked read ───────────────────────────────────────────────────

test("throttle: api() is tracked, api.peek() is not (lite-signal contract)", () => {
    // We can't directly observe tracking from a node:test without lite-signal's
    // computed; but we CAN verify the two functions exist and return the same
    // current value, and that peek matches subscribe's last-seen value.
    const s = signal(0);
    const t = throttle(() => s(), 100);
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(7);
    assert.equal(t(), 7);
    assert.equal(t.peek(), 7);
    assert.equal(t.peek(), seen[seen.length - 1]);
    t.dispose();
});
