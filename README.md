# @zakkster/lite-throttle

> Zero-GC reactive throttle for `@zakkster/lite-signal`. Timer-based and `requestAnimationFrame`-aligned variants, intent-guarded writes, synchronous emit, no per-change allocations.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-throttle.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-throttle)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-throttle?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-throttle)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-throttle?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-throttle)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-throttle?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-throttle)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational?style=flat-square)
[![lite-signal peer](https://img.shields.io/npm/dependency-version/@zakkster/lite-throttle/peer/@zakkster/lite-signal?style=for-the-badge&color=blue)](https://github.com/PeshoVurtoleta/lite-signal)
![Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen?style=flat-square)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE.txt)

```bash
npm install @zakkster/lite-throttle @zakkster/lite-signal
```

```js
import { signal, effect } from "@zakkster/lite-signal";
import { throttleRAF } from "@zakkster/lite-throttle";

const pointer = signal({ x: 0, y: 0 });
const framed = throttleRAF(() => pointer());

effect(() => drawCursor(framed()));

// Fast input source -- the canvas only redraws once per frame.
canvas.addEventListener("pointermove", (e) => {
    pointer.set({ x: e.clientX, y: e.clientY });
});
```

Synchronous leading emit, frame-aligned trailing fire. The hot path is straight integer arithmetic on three closures pre-allocated at construction.

---

## Imperative vs. Reactive (Coming from Lodash?)

**lite-throttle is *not* a drop-in replacement for `lodash.throttle`.**

Lodash is **imperative**:  
You wrap a callback and *push* values into it manually.

lite-throttle is **reactive**:  
You wrap a *tracked state source*, and the reactive graph *pulls* updates automatically.

If you try to use it like Lodash, it will run **exactly once**, register **zero dependencies**, and never fire again.

---

### BAD: Imperative push (Lodash style)

```js
import { throttle } from "@zakkster/lite-throttle";

// This will NOT work. It tracks no reactive dependencies.
const draw = throttle((v) => render(v), 16);

document.addEventListener("mousemove", (e) => draw(e.clientX));
```

### GOOD: Reactive pull (lite-signal style)

```js
import { signal, effect } from "@zakkster/lite-signal";
import { throttle } from "@zakkster/lite-throttle";

// 1. Define the reactive source
const mouseX = signal(0);

// 2. Derive the throttled state
const throttledX = throttle(() => mouseX(), 16);

// 3. Update the source imperatively
document.addEventListener("mousemove", (e) => mouseX.set(e.clientX));

// 4. React to the throttled state automatically
effect(() => render(throttledX()));
```

---

## Contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [API reference](#api-reference)
- [Examples](#examples)
- [When to use which](#when-to-use-which)
- [Semantics worth knowing](#semantics-worth-knowing)
- [Allocation profile](#allocation-profile)
- [Benchmarks](#benchmarks)
- [Testing](#testing)
- [License](#license)

---

## Why this exists

A pointer or scroll source can fire 1000+ events per second. Naive: render on every event, drop frames. Better: throttle. Naive throttle: read the clock on every event, allocate a fresh `setTimeout` closure per emission. Better still: skip the clock during the lockout (since the value isn't consulted there) and hoist the timer callback to construction time.

`lite-throttle` does both. The flush body is pre-allocated; the effect body is pre-allocated; **`performance.now()` is only called when the lockout has potentially expired** (`timerId === null` for `throttle`, `rafId === null` for `throttleRAF`). During an active burst -- the realistic hot path -- every write goes through three lines of state mutation: intent guard, queue pending, return. No clock read, no timer arm.

Per source change in the hot lockout path, this file allocates zero JS-heap objects.

`throttleRAF` is the variant for render-driven sources -- its emissions align with the host's frame loop, which is what you actually want for cursor trails, scroll-driven parallax, and HUD updates pinned to vsync.

---

## What you get

- **`throttle(sourceFn, ms, { leading?, trailing?, now?, schedule?, cancel? })`** -- leading and/or trailing throttle. Emits the first change immediately; subsequent in-window changes coalesce into one trailing fire at lockout expiry. The edges are configurable (1.1); `ms` accepts a `() => number` for a dynamic window (1.2); `now` / `schedule` / `cancel` inject a custom clock and scheduler (1.2).
- **`throttleRAF(sourceFn, { leading?, trailing?, raf?, caf? })`** -- leading and/or trailing throttle aligned to `requestAnimationFrame`. Same shape, but the trailing fire happens on the next animation frame rather than after a fixed `ms`. `raf` / `caf` inject a custom frame scheduler (1.2); throws at construction if no rAF is available and none was injected (1.2).

Both return a read-only callable api:

```ts
interface ReadonlyDerived<T> {
    (): T;                                         // tracked read
    peek(): T;                                     // untracked read
    subscribe(fn: (v: T) => void): () => void;     // returns unsubscribe
    dispose(): void;                               // cancel + release
    cancel(): void;                                // 1.1: drop the pending trailing emission
    flush(): T;                                    // 1.1: emit the pending value now
    pending(): boolean;                            // 1.2: true iff a trailing emission is queued
}
```

---

## API reference

### `throttle(sourceFn, ms, { leading = true, trailing = true, now?, schedule?, cancel? } = {})`

```ts
function throttle<T>(
    sourceFn: () => T,
    ms: number | (() => number),
    options?: {
        leading?: boolean;
        trailing?: boolean;
        now?: () => number;                             // 1.2, default performance.now
        schedule?: (fn: () => void, ms: number) => unknown;  // 1.2, default setTimeout
        cancel?: (id: unknown) => void;                 // 1.2, default clearTimeout
    },
): ReadonlyDerived<T>;
```

Timer-based leading and/or trailing throttle. `ms` is required -- there is no useful zero-window throttle.

- Leading edge fires immediately on the first non-equal change.
- Subsequent in-lockout changes queue. The most recent value emits at lockout expiry (trailing edge).
- A leading-only quiet window leaves no trailing fire and no armed timer.
- `leading` / `trailing` (1.1) select the edges (both default true). `{ leading: false }` suppresses the immediate emit and fires only the latest value at each window end; `{ trailing: false }` emits the leading edge and drops the rest of the window. `{ leading: false, trailing: false }` emits nothing (degenerate; documented).
- `ms` accepts a `() => number` for a dynamic window (1.2). The reader is called only at potential-leading branches (`timerId === null`) -- never on the inside-lockout hot path, never on the flush path -- and via `untrack`, so signal changes to the window itself do not re-run the effect. See [Semantics worth knowing](#semantics-worth-knowing).
- `now` / `schedule` / `cancel` (1.2) let you inject a custom clock and scheduler. Defaults are `performance.now`, `setTimeout`, `clearTimeout`. Useful for headless tests without global monkey-patching, game engines with a pausable clock, and playback scrubbers driven by their own time domain.

### `throttleRAF(sourceFn, { leading = true, trailing = true, raf?, caf? } = {})`

```ts
function throttleRAF<T>(
    sourceFn: () => T,
    options?: {
        leading?: boolean;
        trailing?: boolean;
        raf?: (cb: () => void) => unknown;              // 1.2, default globalThis.requestAnimationFrame
        caf?: (id: unknown) => void;                    // 1.2, default globalThis.cancelAnimationFrame
    },
): ReadonlyDerived<T>;
```

Frame-aligned leading and/or trailing throttle. The lockout window is "one animation frame". Same `{ leading, trailing }` selection (1.1) applies, with the frame boundary as the window.

By default requires a host `requestAnimationFrame` / `cancelAnimationFrame` (browser, Deno, modern Node all expose these). **Throws at construction (1.2)** if neither is available and no `{ raf, caf }` were injected -- the error message points at the two workarounds. Previously the constructor silently succeeded and the first `s.set(...)` blew up with `ReferenceError: requestAnimationFrame is not defined`, which was hard to diagnose in SSR paths.

For tests, either inject `{ raf, caf }` explicitly (preferred -- see [Examples](#examples)) or stub the globals in `beforeEach`.

### `.cancel()`, `.flush()`, and `.pending()`

Both apis expose three control methods on top of the base signal shape:

```ts
const t = throttle(() => pointer(), 16);
t.cancel();            // 1.1: drop the pending trailing emission; the output keeps its current value
const v = t.flush();   // 1.1: emit the pending trailing value now (no-op if nothing pending); returns the current output
t.pending();           // 1.2: true iff a trailing emission is currently queued
```

`cancel()` clears the pending timer / frame and the buffered value; the instance stays live. `flush()` emits the buffered trailing value immediately and resets the window. `pending()` is a cheap boolean predicate -- safe to poll from a subscriber, a UI render, or a save-status indicator. Mirrors lodash's throttle surface for the reactive analogue.

---

## Examples

**Cursor render at the frame rate, regardless of pointer event frequency:**

```js
import { signal, effect } from "@zakkster/lite-signal";
import { throttleRAF } from "@zakkster/lite-throttle";

const pointer = signal({ x: 0, y: 0 });
const framed = throttleRAF(() => pointer());

effect(() => drawCursor(framed()));

canvas.addEventListener("pointermove", (e) => {
    pointer.set({ x: e.clientX, y: e.clientY });
});
```

**Resize handler capped at 16 ms (~ 60 Hz):**

```js
import { signal } from "@zakkster/lite-signal";
import { throttle } from "@zakkster/lite-throttle";

const viewport = signal({ w: window.innerWidth, h: window.innerHeight });
const throttled = throttle(() => viewport(), 16);
throttled.subscribe(({ w, h }) => relayout(w, h));

window.addEventListener("resize", () => {
    viewport.set({ w: window.innerWidth, h: window.innerHeight });
});
```

**Scroll-driven HUD update once per frame:**

```js
import { signal, effect } from "@zakkster/lite-signal";
import { throttleRAF } from "@zakkster/lite-throttle";

const scrollY = signal(0);
const yPerFrame = throttleRAF(() => scrollY());

effect(() => hud.setProgress(yPerFrame() / document.body.scrollHeight));

window.addEventListener("scroll", () => scrollY.set(window.scrollY), { passive: true });
```

**Dynamic window driven by a settings signal (1.2):**

```js
import { signal } from "@zakkster/lite-signal";
import { throttle } from "@zakkster/lite-throttle";

const settings = signal({ throttleMs: 100 });
const src = signal(0);

// The window function is read via untrack -- changing settings.throttleMs
// does NOT re-fire the source-reading effect. It takes effect on the NEXT
// potential-leading branch (either after a lockout expires or on a fresh
// window). Consumers wanting reactive reconfig do it without rebuilding.
const t = throttle(() => src(), () => settings().throttleMs);

// Adjust at runtime:
settings.set({ throttleMs: 20 });
```

**"Saving..." indicator driven by `pending()` (1.2):**

```js
import { signal, effect } from "@zakkster/lite-signal";
import { throttle } from "@zakkster/lite-throttle";

const draft = signal("");
const savedDraft = throttle(() => draft(), 500);
savedDraft.subscribe(v => api.save(v));

// Cheap to poll -- pending() is a boolean read on a closure variable.
effect(() => {
    saveBadge.textContent = savedDraft.pending() ? "Saving..." : "Saved";
});
```

**Headless test without touching globals (1.2):**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { signal } from "@zakkster/lite-signal";
import { throttle } from "@zakkster/lite-throttle";

test("burst inside a 100ms window emits leading + one trailing", () => {
    let clk = 0;
    let queued = null;
    const s = signal(0);
    const t = throttle(() => s(), 100, {
        now: () => clk,
        schedule: (fn) => { queued = fn; return 1; },
        cancel: () => { queued = null; },
    });
    const seen = [];
    t.subscribe(v => seen.push(v));
    seen.length = 0;

    s.set(1); s.set(2); s.set(3);     // leading, then two queued
    assert.deepEqual(seen, [1]);
    clk = 100;
    queued();                         // simulate the trailing fire
    assert.deepEqual(seen, [1, 3]);
    t.dispose();
});
```

No `mock.timers`, no global `performance` stub -- the injected `now` / `schedule` / `cancel` fully drive the engine. Same shape works for `throttleRAF` with `{ raf, caf }`.

---

## When to use which

| You want                                                | Use                            |
| ------------------------------------------------------- | ------------------------------ |
| Emit at a fixed-ms cadence regardless of frame timing   | `throttle(src, ms)`            |
| Emit aligned to the render frame                        | `throttleRAF(src)`             |
| Wait for the burst to settle, then fire once            | `debounce` (separate package)  |
| Fire only the first event in a window                   | `debounceLeading` (separate)   |

`throttle` and `throttleRAF` both emit during a burst. `debounce` emits after a burst. If your dropped output is mid-burst noise, debounce. If you want a refresh rate during the burst, throttle.

Use `throttleRAF` when the consumer renders (canvas, WebGL, transform-style DOM mutation). Use `throttle(src, 16)` when the consumer does anything other than render at vsync -- `requestAnimationFrame` is paused in background tabs, and you usually don't want your data updates to pause with it.

---

## Semantics worth knowing

- **Equality-passthrough.** The output signal uses lite-signal's default `Object.is` equality. A leading or trailing emit whose value matches the current output won't notify subscribers. If you need notify-on-every-fire regardless of value, project the source through a tuple.
- **`NaN` is its own match.** Same as everywhere in lite-signal -- `Object.is(NaN, NaN) === true`.
- **Disposal is on the api, not via the polymorphic helper.** The api is a callable. Always call `api.dispose()` directly; `dispose(api)` from `lite-signal` would invoke it as an effect handle.
- **Re-entrant writes are safe.** A subscriber that writes back to the source during the trailing fire correctly queues a new emission -- the implementation snapshots and clears `pendingValue` before `out.set`, so the re-entrant write isn't wiped. (This was a real bug fixed during the audit; the regression test lives in `test/02-raf-corner-cases.test.js`.)
- **`throttleRAF` double-emit on re-entrant write.** If a subscriber writes back to the source during the trailing fire, `rafId` has just been cleared and the re-queued effect run takes the leading-edge branch -- opening a new rAF window with that value. The consumer sees two emissions in one tick: the trailing, then the new leading. Correct, but worth knowing if you write feedback loops.
- **Ownership cascade cleanup (1.2).** A throttle constructed inside an effect body (or computed body) is owned by that effect: when the parent re-runs or disposes, the throttle's pending `setTimeout` / `rAF` is cancelled and its closure state is cleared. Called at top level (no enclosing owner), only `api.dispose()` cleans up, matching the pre-1.2 contract. Before this fix, cascade dispose released the reactive graph but left the timer armed to fire against a torn-down downstream -- silent leak.
- **Dynamic `ms` is untracked (1.2).** When `ms` is a `() => number`, the reader is called via `untrack` at the potential-leading branch. Changing the window (via a signal or a plain closure) does not re-run the source-reading effect and does not emit spuriously. The window is configuration, not a value dependency. A change to `ms` takes effect on the next window boundary, not the current in-flight one -- an armed timer runs to its original duration.

---

## Allocation profile

| Op                            | JS-heap allocations from this file | Notes |
| ----------------------------- | ----------------------------------- | ----- |
| `throttle()` / `throttleRAF()` construction | 1 signal node, 1 effect, links + a handful of closures | One-time, from the pool. Unchanged from 1.1 -- the 1.2 cascade fix adds an `onCleanup` registration, no extra node. |
| Per source change inside lockout  | **0** | Three-line state mutation. |
| Per leading edge              | **0** (one `setTimeout` or `rAF` arm) | V8-internal timer / rAF record. |
| Per trailing fire             | **0** | `flush` is pre-allocated. |

`throttleRAF`'s steady-state hot path during a burst is the tightest of the four utilities in `lite-debounce` + `lite-throttle` -- no timer queue churn at all once the first `rAF` is armed.

---

## Benchmarks

Run yourself:

```bash
npm install --no-save lodash.throttle
npm run bench
```

The harness runs **5 rounds** of 100,000 source writes per implementation, after a 10,000-iteration warm-up, and reports the **median** with `[min..max]` so V8 JIT tier-up variance is visible instead of looking like a bench bug.

Reference numbers from `npm run bench` on Node 23 (MacBook x64), timer-based throttle, `ms=10`:

| Implementation                          | median ops/s | min..max         | heap delta/op |
| --------------------------------------- | ------------ | ---------------- | -------- |
| `@zakkster/lite-throttle.throttle`      | **7,741K**   | 6,653K..13,898K  | **−0.04 B** |
| naive `effect` + `setTimeout` closure   | 4,675K       | 4,385K..5,633K   | 0.05 B   |
| `lodash.throttle` in `effect`           | 3,915K       | 3,522K..4,094K   | 0.13 B   |

rAF-aligned throttle (stubbed rAF, in-lockout writes):

| Implementation                          | median ops/s | min..max         | heap delta/op |
| --------------------------------------- | ------------ | ---------------- | -------- |
| `@zakkster/lite-throttle.throttleRAF`   | **10,245K**  | 6,542K..11,352K  | 0.09 B   |
| naive `effect` + `rAF` closure          | 9,496K       | 8,494K..12,585K  | 0.26 B   |

The `throttleRAF` bench uses a stubbed `requestAnimationFrame` whose queue is never drained during the timed loop, so every measured write hits the lockout branch -- the realistic hot path during a burst. The negative heap delta on `throttle` means the GC reclaimed more than was allocated across the 100k-set window: the steady-state path is genuinely zero-alloc, and the only retention is incidental V8 housekeeping.

Your numbers will differ -- JIT behavior is hardware- and Node-version-specific. The ordering between implementations is what's portable. Re-run on the publish target and paste the table.

---

## Testing

Two tiers, on `node --test` (no test-runner dependency):

```bash
npm test          # 61 deterministic pass + 2 skip (zero-GC needs --expose-gc), ~1s
npm run test:gc   # all 63 tests including hot-path retention budgets, ~1.4s
```

**63 tests** across eight files, no wall-clock flake (a manual frame clock and lockstep fake `performance.now()` drive the timer engine; a manual `requestAnimationFrame` stub drives the rAF engine; the 1.2 DI tests avoid globals entirely):

| File | Tests | Coverage |
|---|---:|---|
| `01-edges-and-control.test.js` | 9 | Leading/trailing combos, leading-only, trailing-only, cancel, flush, across both engines |
| `02-raf-corner-cases.test.js` | 9 | No-trailing-without-change, re-emits-leading-on-new-frame, intent guard short-circuit, NaN dedupe, dispose-mid-frame, re-entrant set on leading edge, re-entrant set during trailing fire (the "two emits in one tick" feedback-loop quirk), dispose idempotency |
| `03-timer-corner-cases.test.js` | 10 | Same-value writes short-circuited (output- and pending-equal), lockout-fully-expired path, dispose idempotency, cancel/flush no-pending safety, subscribe value-now-and-on-change, multi-subscriber independence, peek vs tracked read |
| `04-degenerate-and-runtime.test.js` | 9 | Both-edges-disabled emits nothing, trailing-disabled inside lockout drops with no late catch-up, leading-disabled first write opens the trailing window, post-lockout same-value write is a true no-op, full api shape across both engines |
| `05-pending-and-dynamic-ms.test.js` (1.2) | 8 | `.pending()` state across the burst / cancel / flush lifecycle on both engines; dynamic `ms` read counts (proving the hot-path branch never touches it); mid-flight ms changes take effect on the next window boundary; `ms` reader is untracked (window signal changes don't fire the effect) |
| `06-ownership-cascade.test.js` (1.2) | 6 | Parent-scope dispose cascades to timer / rAF cancel on both engines; manual `api.dispose` still cancels (regression); dispose remains idempotent |
| `07-dependency-injection.test.js` (1.2) | 8 | Injected `{ now, schedule, cancel }` drive the timer engine end-to-end; injected `{ raf, caf }` drive the rAF engine end-to-end; handles round-trip exactly through DI; construction-time throw when globals unavailable AND nothing injected; injected DI works even without globals (SSR / worker path) |
| `zero-gc.test.js` | 2 + 2 | Hot-path retention < 10 B/op across 50k sets (both engines, min of 3 runs); 2 structural twin tests proving 10k writes collapse to leading + trailing for each engine |

The 1.2 DI tests (`07-dependency-injection.test.js`) demonstrate the pattern of driving both engines with injected clocks / schedulers -- no `mock.timers`, no globals stubbing, no `performance` shim. That's the same pattern to reach for in any downstream package that wants to test its throttled derivations deterministically.

---

## License

MIT (c) Zahary Shinikchiev

---

> Part of the **@zakkster** zero-GC stack: [`lite-signal`](https://www.npmjs.com/package/@zakkster/lite-signal) - [`lite-debounce`](https://www.npmjs.com/package/@zakkster/lite-debounce) - [`lite-ecs`](https://www.npmjs.com/package/@zakkster/lite-ecs) - [`lite-ease`](https://www.npmjs.com/package/@zakkster/lite-ease) - [`lite-pointer-tracker`](https://www.npmjs.com/package/@zakkster/lite-pointer-tracker) - [`lite-bmfont`](https://www.npmjs.com/package/@zakkster/lite-bmfont) - [`lite-color`](https://www.npmjs.com/package/@zakkster/lite-color)
