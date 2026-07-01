// 02-raf-corner-cases.test.js
// Ports the previously-orphan vitest tests (throttleRAF_test.js) to node:test
// so they actually run, plus a few rAF-specific edges not in 01.
//
// PORTED FROM VITEST: emits-no-trailing-without-change, re-emits-leading-on-
// new-frame, intent-guard-no-op, NaN-dedupe, dispose-mid-frame, re-entrant-
// write-on-leading-edge, re-entrant-write-during-trailing-fire (the documented
// "two emissions in one tick" architectural quirk for feedback loops).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { signal } from "@zakkster/lite-signal";
import { throttleRAF } from "../ThrottleRAF.js";

let rafQueue = [];
let rafSeq = 1;
const realRAF = globalThis.requestAnimationFrame;
const realCAF = globalThis.cancelAnimationFrame;

beforeEach(() => {
    rafQueue = [];
    rafSeq = 1;
    globalThis.requestAnimationFrame = (cb) => { const id = rafSeq++; rafQueue.push([id, cb]); return id; };
    globalThis.cancelAnimationFrame = (id) => { rafQueue = rafQueue.filter(([i]) => i !== id); };
});
afterEach(() => {
    globalThis.requestAnimationFrame = realRAF;
    globalThis.cancelAnimationFrame = realCAF;
});

function flushFrame() {
    const q = rafQueue;
    rafQueue = [];
    for (const [, cb] of q) cb();
}

// ─── Trailing absence ───────────────────────────────────────────────────────

test("throttleRAF: emits no trailing when no change arrived during the frame", () => {
    const s = signal(0);
    const t = throttleRAF(() => s());
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1);                              // leading emit
    flushFrame();                          // no change since -> no trailing
    assert.deepEqual(seen, [1]);
    assert.equal(rafQueue.length, 0, "no new rAF armed");
    t.dispose();
});

// ─── Lockout cycle ──────────────────────────────────────────────────────────

test("throttleRAF: re-emits leading on a NEW frame after the previous one fired", () => {
    const s = signal(0);
    const t = throttleRAF(() => s());
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1);                              // leading
    flushFrame();                          // lockout cleared
    s.set(2);                              // qualifies as new leading
    assert.deepEqual(seen, [1, 2]);
    t.dispose();
});

// ─── Intent guard ───────────────────────────────────────────────────────────

test("throttleRAF: intent guard short-circuits a no-op write (no rAF armed)", () => {
    const s = signal(5);
    const t = throttleRAF(() => s());
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(5);                              // identical to current output
    assert.deepEqual(seen, []);
    assert.equal(rafQueue.length, 0, "no rAF was armed for a no-op write");
    t.dispose();
});

test("throttleRAF: treats NaN as equal to NaN (Object.is contract)", () => {
    const s = signal(NaN);
    const t = throttleRAF(() => s());
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(NaN);                            // Object.is(NaN, NaN) -> true
    assert.deepEqual(seen, []);
    t.dispose();
});

// ─── Disposal ───────────────────────────────────────────────────────────────

test("throttleRAF: dispose mid-frame cancels the trailing flush", () => {
    const s = signal(0);
    const t = throttleRAF(() => s());
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1);                              // leading
    s.set(2);                              // queued
    t.dispose();
    flushFrame();
    assert.deepEqual(seen, [1], "trailing 2 never emitted");
    assert.equal(rafQueue.length, 0, "no zombie rAF");
});

// ─── Re-entrant writes ──────────────────────────────────────────────────────

test("throttleRAF: re-entrant set inside a subscriber on the LEADING edge queues for next frame", () => {
    const s = signal(0);
    const t = throttleRAF(() => s());
    const seen = [];
    let armed = false;
    let bounced = false;
    t.subscribe((v) => {
        if (!armed) return;
        seen.push(v);
        if (!bounced) { bounced = true; s.set(99); }
    });
    armed = true;

    s.set(1);
    // Subscriber receives 1 (leading). Inside the subscriber it writes 99.
    // That re-runs the effect: rafId !== 0 now (we just armed for trailing),
    // so it takes the inside-lockout branch and queues pendingValue=99.
    assert.deepEqual(seen, [1]);
    flushFrame();
    assert.deepEqual(seen, [1, 99], "queued re-entrant value emitted on next frame");
    t.dispose();
});

test("throttleRAF: re-entrant set DURING a trailing fire opens a new leading edge (two emits in one tick)", () => {
    // Documented architectural consequence: when a subscriber writes back to
    // the source during a trailing emission, rafId === 0 (just cleared by
    // flush()). The re-entered effect takes the leading-edge branch -- emits
    // the new value and arms a new rAF. The consumer sees TWO emits in the
    // same tick: the trailing, then the new leading. This is correct
    // ("lockout just ended, new write is a fresh leading edge"), but worth
    // pinning down for anyone writing feedback loops.
    const s = signal(0);
    const t = throttleRAF(() => s());
    const seen = [];
    let armed = false;
    let bouncedOnce = false;
    t.subscribe((v) => {
        if (!armed) return;
        seen.push(v);
        if (v === 3 && !bouncedOnce) {
            bouncedOnce = true;
            s.set(99);                     // write-back during trailing fire
        }
    });
    armed = true;

    s.set(1);                              // leading -> 1
    s.set(2);                              // queued
    s.set(3);                              // queued (pendingValue=3)
    flushFrame();                          // trailing fires 3; subscriber re-enters with 99
    assert.deepEqual(seen, [1, 3, 99], "trailing, then new leading, in one tick");
    flushFrame();                          // rAF armed by the new leading; no further change
    assert.deepEqual(seen, [1, 3, 99]);
    t.dispose();
});

// ─── Additional rAF edges (new) ─────────────────────────────────────────────

test("throttleRAF: trailing flush with no change since leading emits nothing", () => {
    // Equivalent to "no trailing without change" but as a sequencing test:
    // armed by leading, then idle through the whole frame -> flush() finds
    // !hasPending and returns early. This is the "1 leading per frame is the
    // floor" property, and we test it explicitly.
    const s = signal(0);
    const t = throttleRAF(() => s());
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1);                              // leading; rAF armed
    flushFrame();                          // flush finds nothing pending; just clears rafId
    assert.deepEqual(seen, [1]);
    t.dispose();
});

test("throttleRAF: dispose is idempotent", () => {
    const s = signal(0);
    const t = throttleRAF(() => s());
    s.set(1);
    s.set(2);
    assert.doesNotThrow(() => { t.dispose(); t.dispose(); t.dispose(); });
});
