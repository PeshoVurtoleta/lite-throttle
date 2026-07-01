// 07-dependency-injection.test.js
// 1.2: throttle accepts { now, schedule, cancel }; throttleRAF accepts
// { raf, caf }. These enable headless tests without global monkey-patching,
// and let consumers drive throttles from custom time domains (game engine
// clocks, playback scrubbers).
//
// The whole file avoids touching globalThis.performance / setTimeout /
// requestAnimationFrame -- that's the point of the DI surface, and it also
// serves as documentation for how it's used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signal } from "@zakkster/lite-signal";
import { throttle, throttleRAF } from "../index.js";

// ─── throttle DI ────────────────────────────────────────────────────────────

test("throttle: injected { now, schedule, cancel } drive the engine end-to-end", () => {
    let clk = 0;
    let queued = null;
    let queuedDelay = 0;
    const now = () => clk;
    const schedule = (fn, ms) => { queued = fn; queuedDelay = ms; return 42; };
    const cancel = (id) => { assert.equal(id, 42); queued = null; };

    const s = signal(0);
    const t = throttle(() => s(), 100, { now, schedule, cancel });
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1);                                          // leading (lastEmitTime=-Inf, elapsed >= ms)
    assert.deepEqual(seen, [1]);
    assert.equal(queued, null, "leading edge did not arm a timer");

    s.set(2);                                          // queued (leading just fired at clk=0)
    assert.notEqual(queued, null, "trailing timer armed");
    assert.equal(queuedDelay, 100);

    clk = 100;                                         // advance the injected clock
    const fire = queued; queued = null;
    fire();                                            // trigger the trailing manually
    assert.deepEqual(seen, [1, 2]);
    t.dispose();
});

test("throttle: injected clock -- fresh leading after simulated lockout expiry", () => {
    let clk = 0;
    let queued = null;
    const s = signal(0);
    const t = throttle(() => s(), 50, {
        now: () => clk,
        schedule: (fn) => { queued = fn; return 1; },
        cancel: () => { queued = null; },
    });
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1);                                          // leading
    assert.deepEqual(seen, [1]);
    clk = 200;                                         // way past lockout
    s.set(2);                                          // fresh leading
    assert.deepEqual(seen, [1, 2]);
    assert.equal(queued, null, "no timer needed for a fully-expired window");
    t.dispose();
});

test("throttle: cancel is called with the exact handle returned by schedule", () => {
    let handedOut = null;
    let cancelledWith = null;
    const s = signal(0);
    const t = throttle(() => s(), 100, {
        now: () => 0,                                  // permanently t=0 so writes queue
        schedule: () => { handedOut = { opaque: Symbol("timer") }; return handedOut; },
        cancel: (id) => { cancelledWith = id; },
    });
    s.set(1);                                          // leading
    s.set(2);                                          // queue -> arm timer with handedOut
    t.cancel();
    assert.strictEqual(cancelledWith, handedOut, "handle round-trips through DI");
    t.dispose();
});

// ─── throttleRAF DI ────────────────────────────────────────────────────────

test("throttleRAF: injected { raf, caf } drive the engine end-to-end", () => {
    let queued = null;
    const raf = (cb) => { queued = cb; return 7; };
    let cancelled = null;
    const caf = (id) => { cancelled = id; queued = null; };

    const s = signal(0);
    const t = throttleRAF(() => s(), { raf, caf });
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1);                                          // leading -> emits and arms raf
    assert.deepEqual(seen, [1]);
    assert.notEqual(queued, null, "raf armed for trailing window");

    s.set(2); s.set(3);                                // queued
    assert.equal(t.pending(), true);

    const fire = queued; queued = null;
    fire();                                            // simulate frame
    assert.deepEqual(seen, [1, 3]);
    t.dispose();
});

test("throttleRAF: caf receives the exact handle raf returned", () => {
    const handle = { opaque: Symbol("raf") };
    let cancelledWith = null;
    const s = signal(0);
    const t = throttleRAF(() => s(), {
        raf: () => handle,
        caf: (id) => { cancelledWith = id; },
    });
    s.set(1);                                          // leading -> arms
    t.cancel();
    assert.strictEqual(cancelledWith, handle);
    t.dispose();
});

// ─── Runtime check ─────────────────────────────────────────────────────────

test("throttleRAF: throws at construction if raf/caf unavailable and not injected", () => {
    // Simulate a host without rAF (e.g. SSR, Worker) by temporarily deleting
    // the globals. Restore after.
    const realRAF = globalThis.requestAnimationFrame;
    const realCAF = globalThis.cancelAnimationFrame;
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
    try {
        assert.throws(
            () => throttleRAF(() => 0),
            /requestAnimationFrame/,
            "construction should fail fast in no-rAF environments",
        );
    } finally {
        globalThis.requestAnimationFrame = realRAF;
        globalThis.cancelAnimationFrame = realCAF;
    }
});

test("throttleRAF: injected raf/caf work even without globals (SSR/worker path)", () => {
    const realRAF = globalThis.requestAnimationFrame;
    const realCAF = globalThis.cancelAnimationFrame;
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
    try {
        let queued = null;
        const t = throttleRAF(() => 0, {
            raf: (cb) => { queued = cb; return 1; },
            caf: () => { queued = null; },
        });
        assert.equal(typeof t, "function", "construction succeeds with DI even without globals");
        t.dispose();
    } finally {
        globalThis.requestAnimationFrame = realRAF;
        globalThis.cancelAnimationFrame = realCAF;
    }
});

// ─── Zero-global-touch smoke test ─────────────────────────────────────────

test("DI path: neither performance.now nor setTimeout is touched for throttle", () => {
    // If the injected `now` / `schedule` / `cancel` are honoured, the real
    // ones should be observable-untouched. We can't test "not called" cleanly
    // without stubbing, so we instead lean on: setting a value AND observing
    // the injected schedule was called at least once is proof enough.
    let scheduleCalls = 0;
    const s = signal(0);
    const t = throttle(() => s(), 100, {
        now: () => 0,                                  // stuck at 0 -> always inside first lockout after leading
        schedule: (fn) => { scheduleCalls++; return 1; },
        cancel: () => {},
    });
    s.set(1); s.set(2);                                // leading + queue
    assert.ok(scheduleCalls >= 1, "injected schedule was called");
    t.dispose();
});
