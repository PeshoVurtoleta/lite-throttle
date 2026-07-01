// @zakkster/lite-throttle 1.1 -- node --test. Timer engine uses a lockstep fake
// clock (performance.now) advanced alongside node:test mock timers; the rAF engine
// uses a controllable fake requestAnimationFrame queue (no real rAF in CI).
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

// ---- throttle (timer) --------------------------------------------------------
test("throttle leading+trailing: leading now, trailing at window end", () => {
    const s = signal(0);
    const t = throttle(() => s(), 100);
    const seen = [];
    t.subscribe(v => seen.push(v));            // [0]
    s.set(1);                                  // leading
    s.set(2); s.set(3);                        // queued trailing
    assert.deepEqual(seen, [0, 1]);
    advance(100);
    assert.deepEqual(seen, [0, 1, 3]);
    t.dispose();
});

test("throttle leading-only drops within the window", () => {
    const s = signal(0);
    const t = throttle(() => s(), 100, { trailing: false });
    const seen = [];
    t.subscribe(v => seen.push(v));            // [0]
    s.set(1);                                  // leading
    s.set(2); s.set(3);                        // dropped
    advance(100);
    assert.deepEqual(seen, [0, 1]);
    s.set(4);                                  // window cleared -> new leading
    assert.deepEqual(seen, [0, 1, 4]);
    t.dispose();
});

test("throttle trailing-only emits the latest at window end, no leading", () => {
    const s = signal(0);
    const t = throttle(() => s(), 100, { leading: false });
    const seen = [];
    t.subscribe(v => seen.push(v));            // [0]
    s.set(1);                                  // no leading; window opens
    s.set(2); s.set(3);                        // queued
    assert.deepEqual(seen, [0]);
    advance(100);                              // trailing emit
    assert.deepEqual(seen, [0, 3]);
    t.dispose();
});

test("throttle cancel drops the pending trailing", () => {
    const s = signal(0);
    const t = throttle(() => s(), 100);
    const seen = [];
    t.subscribe(v => seen.push(v));            // [0]
    s.set(1);                                  // leading
    s.set(2);                                  // pending trailing
    t.cancel();
    advance(200);
    assert.deepEqual(seen, [0, 1]);
    t.dispose();
});

test("throttle flush emits the pending trailing now and returns it", () => {
    const s = signal(0);
    const t = throttle(() => s(), 100);
    const seen = [];
    t.subscribe(v => seen.push(v));            // [0]
    s.set(1); s.set(2);
    const r = t.flush();
    assert.equal(r, 2);
    assert.deepEqual(seen, [0, 1, 2]);
    advance(200);                              // no double emit
    assert.deepEqual(seen, [0, 1, 2]);
    t.dispose();
});

// ---- throttleRAF -------------------------------------------------------------
test("throttleRAF leading+trailing across a frame", () => {
    const s = signal(0);
    const t = throttleRAF(() => s());
    const seen = [];
    t.subscribe(v => seen.push(v));            // [0]
    s.set(1);                                  // leading
    s.set(2); s.set(3);                        // queued trailing
    assert.deepEqual(seen, [0, 1]);
    flushFrame();
    assert.deepEqual(seen, [0, 1, 3]);
    t.dispose();
});

test("throttleRAF trailing-only: latest at frame boundary, no leading", () => {
    const s = signal(0);
    const t = throttleRAF(() => s(), { leading: false });
    const seen = [];
    t.subscribe(v => seen.push(v));            // [0]
    s.set(1); s.set(2);
    assert.deepEqual(seen, [0]);               // no leading
    flushFrame();
    assert.deepEqual(seen, [0, 2]);
    t.dispose();
});

test("throttleRAF leading-only drops within the frame", () => {
    const s = signal(0);
    const t = throttleRAF(() => s(), { trailing: false });
    const seen = [];
    t.subscribe(v => seen.push(v));            // [0]
    s.set(1);                                  // leading
    s.set(2);                                  // dropped
    flushFrame();
    assert.deepEqual(seen, [0, 1]);
    s.set(3);                                  // frame cleared -> new leading
    assert.deepEqual(seen, [0, 1, 3]);
    t.dispose();
});

test("throttleRAF flush + cancel", () => {
    const s = signal(0);
    const t = throttleRAF(() => s());
    const seen = [];
    t.subscribe(v => seen.push(v));            // [0]
    s.set(1); s.set(2);                        // leading 1, queue 2
    assert.equal(t.flush(), 2);
    assert.deepEqual(seen, [0, 1, 2]);
    s.set(3);                                  // leading 3 (frame was flushed)
    s.set(4);                                  // queue 4
    t.cancel();                                // drop 4
    flushFrame();
    assert.deepEqual(seen, [0, 1, 2, 3]);
    t.dispose();
});
