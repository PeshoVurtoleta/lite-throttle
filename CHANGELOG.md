# Changelog

All notable changes to `@zakkster/lite-throttle` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-XX-XX

Additive release, plus one correctness fix. No breaking API changes.

### Fixed

- **Ownership cascade cleanup.** When a parent effect / scope disposed, the
  reactive graph was released but any armed `setTimeout` / `requestAnimationFrame`
  was left to fire against a torn-down downstream — silent leak, "why is this
  still firing" mystery. Both engines now register an `onCleanup` at the
  constructor's synchronous call site, which attaches to the caller's
  `currentOwner` (whatever effect or computed the caller was inside). When
  that owner re-runs or disposes, `runCleanup` fires our attached cleanup
  after cascade-disposing our source-reading effect. At top level (no
  enclosing owner), the `onCleanup` is a no-op and `api.dispose()` is the
  only cleanup path — matching the pre-1.2 contract. Manual `api.dispose()`
  behavior is unchanged; the fix strictly closes the gap when the caller
  never touches `api.dispose()` themselves. Regression test in
  `test/06-ownership-cascade.test.js`.

### Added

- **`api.pending()` — boolean predicate** on both engines. `true` iff a
  trailing emission is currently queued. Cheap; safe to poll from a subscriber
  or a UI framework's render (e.g. disabling a "flush now" button). Mirrors
  lodash's throttle surface.
- **Dynamic `ms`** — `throttle(sourceFn, msOrFn)` accepts either a number or
  a `() => number`. The reader is called only at potential-leading branches
  (never on the inside-lockout hot path, never on the flush path), and via
  `untrack` so signal changes to the window itself do not re-run the effect
  (the window is configuration, not a value dependency). Consumers who need
  the window to change mid-flight can now do:
  ```js
  const t = throttle(() => src(), () => settings().throttleMs);
  ```
  without rebuilding.
- **Dependency-injection surface for the clock and scheduler:**
  - `throttle(sourceFn, ms, { now, schedule, cancel })` — inject a clock
    (`() => number`), scheduler (`(fn, ms) => id`), and canceller
    (`(id) => void`). Defaults are `performance.now`, `setTimeout`,
    `clearTimeout`.
  - `throttleRAF(sourceFn, { raf, caf })` — inject rAF and cAF. Defaults
    are `globalThis.requestAnimationFrame` / `cancelAnimationFrame`.

  This enables headless tests without global monkey-patching (the new
  `test/07-dependency-injection.test.js` demonstrates the pattern), custom
  time domains (game engines with a pausable clock, playback scrubbers), and
  SSR / Worker consumers who want to supply their own scheduling primitives.
- **Construction-time rAF availability check.** `throttleRAF` now throws a
  clear error at construction if neither `globalThis.requestAnimationFrame`
  nor `options.raf` is available, with a message pointing at the two
  workarounds (`throttle(fn, 16)` or explicit `{ raf, caf }`). Previously
  construction silently succeeded and the first `s.set(...)` blew up with
  `ReferenceError: requestAnimationFrame is not defined` — hard to diagnose,
  especially in SSR paths.

### Changed

- `ThrottleRAF.js` internal idle sentinel switched from `0` to `null`. Zero was
  fine when only real rAF was in play (rAF never returns 0), but with injected
  `raf` a scheduler returning 0 as its handle would be misread as "idle". Purely
  internal — no observable API change.
- Peer range simplified: `"^1.2.0 || >=1.4.0-beta.0 <2.0.0"` → `"^1.2.0"`.
  The original range's second disjunct was redundant — `^1.2.0` already
  resolves to any `>=1.2.0 <2.0.0`.

### Allocation profile

- **Construction:** unchanged from 1.1 — still one signal node + one effect
  node per throttle instance. The cascade fix is a single `onCleanup`
  registration that attaches to the caller's owner scope directly; no
  additional effect node needed.
- **Hot path:** zero-GC contract (`test/zero-gc.test.js`, both engines under
  `--expose-gc`) continues to hold at `< 10 B/op` retained across 50k
  inside-lockout writes, min of 3 runs. The inside-lockout branch is
  byte-for-byte identical to 1.1.

### Tested

- **Three new files**, adding **22 tests** for a running total of **61
  deterministic + 2 zero-GC = 63 tests** (61 pass + 2 skip without
  `--expose-gc`, 63/63 with).
  - `test/05-pending-and-dynamic-ms.test.js` (8 tests) — `.pending()` state
    across the burst / cancel / flush lifecycle on both engines; dynamic
    `ms` read counts (proving the hot-path branch never touches it);
    mid-flight ms changes take effect on the next window boundary; `ms`
    reader is untracked (window signal changes don't fire the effect).
  - `test/06-ownership-cascade.test.js` (6 tests) — parent-scope dispose
    cascades to timer / rAF cancel on both engines; manual `api.dispose`
    still cancels (regression); dispose remains idempotent after the
    cleanup-holder refactor.
  - `test/07-dependency-injection.test.js` (8 tests) — injected
    `{ now, schedule, cancel }` drive the timer engine end-to-end;
    injected `{ raf, caf }` drive the rAF engine end-to-end; handles
    round-trip exactly through DI; construction-time throw when
    globals unavailable AND nothing injected; injected DI works even
    without globals (SSR / worker path).

## [1.1.0] — 2026-06-09

Additive release. No breaking changes; pure surface growth on top of 1.0.
Existing 1.0 callers (no options object) continue to work without
modification — every 1.1 feature is opt-in through the new options bag or
the new methods on the returned api.

### Added

- **Edge selection** — `throttle(src, ms, { leading, trailing })` and
  `throttleRAF(src, { leading, trailing })` accept an options bag. Both edges
  default `true` (the 1.0 behavior).
  - `{ leading: false }` suppresses the leading-edge emission; the trailing
    timer is armed instead so the LATEST value of the burst emits at lockout
    expiry. Trailing-only throttle.
  - `{ trailing: false }` fires the leading edge and drops every change
    inside the lockout — no late catch-up after the window expires either.
    Leading-only throttle.
  - `{ leading: false, trailing: false }` is degenerate: emits nothing.
    Documented and tested for completeness.
- **`api.cancel()`** — drops any pending trailing emission. Output value is
  unchanged; the instance stays usable for subsequent writes. Safe to call
  when nothing is pending.
- **`api.flush()`** — emits the pending trailing value immediately (outside
  the lockout window or current frame) and returns the current output.
  No-op when nothing is pending. The next frame / window cycle starts fresh.

### Architectural invariants (also tested in 1.1)

- **Skip the clock during lockout** (timer engine): once `timerId !== null`,
  subsequent writes don't read `performance.now()` — they queue
  `pendingValue` and return. This is what differentiates lite-throttle from
  a naive wrapper that reads the clock on every write. (Bench shows 7.7M
  ops/sec vs 4.7M for the naive line.)
- **No clock and no rAF churn during the frame lockout** (rAF engine): once
  `rafId !== 0`, in-frame writes are pure state mutation. The tightest hot
  path in either engine. (Bench shows 10.2M ops/sec.)
- **Snapshot-before-set in flush**: `pendingValue` is captured into a local
  and the state is cleared BEFORE `out.set`, because `out.set` is
  synchronous and a subscriber that writes back to the source re-enters the
  effect during emit. Clearing after `out.set` would wipe the re-entrant
  write.
- **Re-entrant write during a throttleRAF trailing fire** is a fresh leading
  edge (rafId was just cleared by flush). The consumer sees TWO emissions
  in one tick: the trailing value, then the new leading value. Correct
  behavior, pinned down by a test for anyone writing feedback loops.

### Tested

- **Five-file test suite** (38 deterministic + 3 zero-GC = **41 tests**),
  matching the multi-file convention used across the `@zakkster/lite-*`
  family. The previously orphan vitest-format file
  (`throttleRAF_test.js`) has been ported to node:test and is **now
  actually running**:
  - `test/01-edges-and-control.test.js` — original 9-test suite covering
    leading+trailing / leading-only / trailing-only across both engines,
    plus cancel and flush.
  - `test/02-raf-corner-cases.test.js` (9 tests) — ports the orphan vitest
    file's coverage to node:test: emits-no-trailing-without-change, re-emits-
    leading-on-new-frame, intent-guard-no-op short-circuit, NaN dedupe,
    dispose-mid-frame, re-entrant set on leading edge, re-entrant set
    during trailing fire (the documented "two emissions in one tick"
    architectural quirk for feedback loops), trailing-flush-with-no-change,
    dispose idempotency.
  - `test/03-timer-corner-cases.test.js` (10 tests) — same-value write is
    short-circuited by intent guard (both at output and pending), lockout-
    fully-expired path takes leading branch, output-equality dedupe at
    lite-signal layer, dispose idempotency, cancel/flush no-pending safety,
    subscribe value-now-and-on-change, multi-subscriber independence,
    peek vs tracked read.
  - `test/04-degenerate-and-runtime.test.js` (9 tests) — both-edges-disabled
    emits nothing (both engines), trailing-disabled inside lockout drops
    with no late catch-up (both engines), leading-disabled first write
    opens the trailing window (both engines), same-value write after
    lockout-expiry is a true no-op, api shape verified (callable +
    peek/subscribe/dispose/cancel/flush on both engines).
  - `test/zero-gc.test.js` (3 tests + 2 structural) — hot-path retention
    contract: 50k `throttle.set()` calls inside the lockout retain
    < 10 B/op (min of 3 runs); same for `throttleRAF.set()` inside the
    frame. Plus two structural twin tests proving the *purpose* of the
    zero-GC hot path: 10k writes inside the window collapse to exactly one
    leading + one trailing emission for each engine. Auto-skipped without
    `--expose-gc`.

  Run `npm test` (38 pass + 2 skip + 3 always-run structural) or
  `npm run test:gc` (**41/41** in ~1.8 s).

- **Vitest infrastructure removed** — `vitest.config.js` and the vitest-
  format test file are no longer in the repo. `vitest` was never in
  `devDependencies`, so the orphan test file had been silently NOT
  running. All its coverage is now in `test/02-raf-corner-cases.test.js`,
  running under the standard node:test runner.

### Demo

- New `demo/index.html` — three-channel scope demo for QA + product review.
  ONE noise source (pointer pad, slider, or "BURST 1000" button) feeds
  three reactive consumers: RAW (every set), throttle (slider-controlled
  ms window), throttleRAF (frame-aligned). Each channel has its own
  oscilloscope strip showing emissions over time, a live emissions count,
  and a "write reduction" percentage. Edge toggles (leading / trailing)
  rebuild both throttle instances live so the contract changes can be seen
  immediately. Runs on the real package via import map — no build step.

## [1.0.0] — 2026-04-XX

Initial release.

### Added

- **`throttle(sourceFn, ms) → ReadonlyDerived<T>`** — leading + trailing
  time-based throttle on a reactive source. First non-equal change emits
  immediately; subsequent in-window changes coalesce into one trailing
  fire at lockout expiry.
- **`throttleRAF(sourceFn) → ReadonlyDerived<T>`** — leading + trailing
  throttle aligned to the host's `requestAnimationFrame`. Same shape;
  the lockout window is one frame.
- **`ReadonlyDerived<T>` api** — callable `() => T` (tracked read), plus
  `.peek()` (untracked), `.subscribe(fn) → unsubscribe` (value-now-and-
  on-change), and `.dispose()` (cancel any pending trailing emission and
  release the effect).
- **Intent guard** — `Object.is(next, hasPending ? pendingValue : out.peek())`
  short-circuits no-op writes before they reach the lockout logic. `NaN`
  is its own match per `Object.is` semantics.
- **Equality passthrough on output** — the internal signal uses lite-
  signal's default `Object.is` equality. A leading or trailing fire whose
  value matches the current output does not notify subscribers.

### Architectural invariants

- **Zero JS-heap allocations per source change in steady state** — verified
  by the benchmark (`bench/benchmark.mjs`, `--expose-gc`) and locked in by
  `test/zero-gc.test.js` (added in 1.1).
- **`api.dispose()` is the disposal contract** — the api is a callable, so
  passing it to lite-signal's generic `dispose` would invoke it under the
  effect-handle contract rather than tearing down. Always call
  `api.dispose()`.
