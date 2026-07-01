/**
 * Throttle.js -- leading + trailing throttle on a reactive source (timer-based).
 *
 * State machine (per-instance):
 *   timerId        setTimeout handle for the trailing fire, null when idle
 *   hasPending     true if a change arrived inside the lockout
 *   pendingValue   most recent source value awaiting the trailing emission
 *   lastEmitTime   `now()` at the most recent emission
 *
 * Per source change in steady state:
 *   1. read source, intent guard
 *   2. if timerId !== null (inside lockout) -> queue pending, return.
 *      No clock read on this branch -- the realistic hot path during a burst.
 *   3. else -> read `now()`, compute elapsed:
 *        elapsed >= ms  -> leading emit, set lastEmitTime
 *        elapsed <  ms  -> queue pending, arm schedule(flush, ms - elapsed)
 *
 * Skipping the clock read inside lockout is the per-write speedup that
 * separates this from a naive wrapper. `performance.now()` is a syscall to the
 * high-resolution clock -- cheap in absolute terms, but at 5-10M writes/s the
 * call overhead dominates everything else.
 *
 * flush() snapshots pendingValue and clears state BEFORE out.set, for the same
 * re-entrant-subscriber reason as Debounce.js. The re-entrant write hits the
 * inside-lockout branch and queues a new trailing fire -- if pendingValue were
 * cleared after out.set, that re-entrant pending value would be wiped.
 *
 * Allocation profile (per instance):
 *   At construction: 1 signal node, 1 effect node, links, plus the flush,
 *   effect-body, dispose, cancel, flushNow, pending, and readMs closures.
 *   Per source change (steady state): zero JS-heap allocations from this file.
 *   `schedule` is called at most once per lockout window (only when the first
 *   trailing change arrives), so timer churn is bounded by 1/ms.
 *
 * Ownership cascade (1.2):
 *   A synchronous `onCleanup(clearTimerState)` call at the end of the
 *   constructor attaches to the CALLER's currentOwner (whatever effect or
 *   computed the caller was inside). When that owner re-runs or disposes,
 *   `runCleanup` fires our attached cleanup after cascade-disposing our
 *   source-reading effect -- guaranteeing the pending setTimeout is cancelled
 *   even when the caller never touches `api.dispose()` themselves. Before 1.2,
 *   the reactive graph was released but the armed timer was left to fire
 *   against a torn-down downstream graph.
 *
 *   Called at top level (no enclosing effect), the onCleanup is a no-op --
 *   only `api.dispose()` cleans up, which matches the pre-1.2 contract.
 */

import {signal, effect, untrack, onCleanup} from "@zakkster/lite-signal";
import {makeReadonlyApi} from "./_shared.js";

const defaultNow = () => performance.now();
const defaultSchedule = (fn, ms) => setTimeout(fn, ms);
const defaultCancel = (id) => clearTimeout(id);

/**
 * @template T
 * @typedef {import("./ThrottleRAF.js").ReadonlyDerived<T>} ReadonlyDerived
 */

/**
 * Leading + trailing throttle on a reactive source.
 *
 * Emits the first change immediately, then suppresses further emissions until
 * `ms` milliseconds have elapsed since the last emit. If any changes arrived
 * during the lockout, the most recent value fires once at lockout expiry
 * (trailing edge).
 *
 * Unlike `debounce`, the trailing fire is bounded -- the output is guaranteed
 * to refresh at least once per `ms` window if the source is changing.
 *
 * The output signal uses default `Object.is` equality. A leading or trailing
 * fire whose value matches the current output value will not notify
 * subscribers. Match the rest of the lite-signal contract.
 *
 * Disposal: `api.dispose()` cancels any pending trailing timer and releases
 * the effect. The api is callable, so do not pass it to `lite-signal.dispose`.
 *
 * @template T
 * @param {() => T} sourceFn                    Tracked source.
 * @param {number | (() => number)} ms          Lockout window in milliseconds.
 *   Can be a function for a dynamic window (1.2); read via untrack at each
 *   potential leading edge, so signal changes to the window itself do not
 *   re-run the effect.
 * @param {{
 *   leading?: boolean,
 *   trailing?: boolean,
 *   now?: () => number,
 *   schedule?: (fn: () => void, ms: number) => unknown,
 *   cancel?: (id: unknown) => void
 * }} [options]
 * @returns {ReadonlyDerived<T>}
 *
 * @example
 *   // 60 fps cap on a fast-changing source
 *   const mouseX = signal(0);
 *   const throttledX = throttle(() => mouseX(), 16);
 *   effect(() => render(throttledX()));
 *
 * @example
 *   // Dynamic window
 *   const settings = signal({ throttleMs: 100 });
 *   const t = throttle(() => src(), () => settings().throttleMs);
 *
 * @example
 *   // Injected scheduler for headless tests
 *   let clk = 0, queued;
 *   const t = throttle(() => src(), 100, {
 *       now: () => clk,
 *       schedule: (fn) => { queued = fn; return 1; },
 *       cancel: () => { queued = undefined; },
 *   });
 */
export function throttle(sourceFn, ms, {
    leading = true,
    trailing = true,
    now = defaultNow,
    schedule = defaultSchedule,
    cancel = defaultCancel,
} = {}) {
    // Dynamic-ms support: normalise to a zero-arg reader. When ms is a plain
    // number we bind it once; when it's a function we untrack the read so
    // signal changes to the window itself do NOT re-run the effect (window
    // is configuration, not a value dependency).
    const readMs = typeof ms === "function" ? () => untrack(ms) : () => ms;

    const out = signal(untrack(sourceFn));

    let timerId = null;
    let hasPending = false;
    let pendingValue;
    // -Infinity so the first write always satisfies (elapsed >= ms) and takes
    // the leading-edge branch, regardless of the host clock's current value.
    // After the first emit this becomes a normal `now()` timestamp.
    let lastEmitTime = -Infinity;

    const flush = () => {
        timerId = null;

        if (!hasPending) return;

        // Snapshot-and-clear before out.set. See Debounce.js for the
        // re-entrant-subscriber rationale.
        const v = pendingValue;
        hasPending = false;
        pendingValue = undefined;
        lastEmitTime = now();
        out.set(v);
    };

    const disposeEffect = effect(() => {
        const nextValue = sourceFn();
        const intent = hasPending ? pendingValue : out.peek();

        if (Object.is(nextValue, intent)) return;

        // Common case during a burst: we're inside the lockout window. The
        // clock value isn't consulted on this branch, so skip the syscall --
        // this is what differentiates lite-throttle from a naive wrapper that
        // reads the clock on every write.
        if (timerId !== null) {
            if (trailing) {
                pendingValue = nextValue;
                hasPending = true;
            }
            return;                              // trailing disabled -> drop inside lockout
        }

        // timerId === null: either fresh, or the previous lockout fully expired.
        const t = now();
        const elapsed = t - lastEmitTime;
        const window = readMs();

        if (elapsed >= window) {
            // Window is open.
            if (leading) {
                // Leading edge: emit now. Lockout is enforced by lastEmitTime;
                // a within-window change below arms the trailing timer.
                lastEmitTime = t;
                out.set(nextValue);
            } else if (trailing) {
                // Leading suppressed: open the window and schedule the trailing fire.
                lastEmitTime = t;
                pendingValue = nextValue;
                hasPending = true;
                timerId = schedule(flush, window);
            }
            // leading && trailing both false -> emit nothing (degenerate; documented).
        } else if (trailing) {
            // Still inside the previous lockout -- arm the trailing timer for the gap.
            pendingValue = nextValue;
            hasPending = true;
            timerId = schedule(flush, window - elapsed);
        }
        // within lockout, trailing disabled -> drop.
    });

    // Ownership-cascade cleanup (1.2). We're synchronously inside the
    // caller's owner scope right now: if this throttle was constructed
    // inside an effect body or computed body, currentOwner is that
    // effect/computed. Registering onCleanup here attaches our timer-clear
    // to the caller's cleanupFn, so `runCleanup` fires it on cascade
    // dispose (parent re-run OR parent dispose). Called at top level with
    // no enclosing owner, this is a no-op -- direct api.dispose() is the
    // only cleanup path, matching the pre-1.2 contract.
    //
    // Cascade ordering (see Signal.js runCleanup, lines 671-708): children
    // dispose first (our source-reading effect), THEN this owner's cleanupFn
    // runs. So our closure state -- timerId, hasPending, pendingValue -- is
    // still alive when the cleanup executes.
    onCleanup(() => {
        if (timerId !== null) {
            cancel(timerId);
            timerId = null;
        }
        hasPending = false;
        pendingValue = undefined;
    });

    const cancelPending = () => {                 // drop the pending trailing emission; output unchanged
        if (timerId !== null) {
            cancel(timerId);
            timerId = null;
        }
        hasPending = false;
        pendingValue = undefined;
    };
    const flushNow = () => {                      // emit the pending trailing value synchronously now
        if (timerId !== null) {
            cancel(timerId);
            timerId = null;
        }
        if (hasPending) {
            const v = pendingValue;
            hasPending = false;
            pendingValue = undefined;
            lastEmitTime = now();
            out.set(v);
        }
        return out.peek();
    };
    const pending = () => hasPending;             // 1.2: true iff a trailing emission is queued

    return makeReadonlyApi(out, () => {
        // Direct dispose path: clear timer state inline, then release the
        // reactive graph. Idempotent -- double-dispose is safe because
        // clearing null-checks and disposeEffect is gen-guarded by
        // lite-signal. If the caller's owner has ALREADY cascade-disposed
        // us, our attached onCleanup has already cleared timer state; this
        // block finds nothing to clear and disposeEffect is a no-op.
        if (timerId !== null) {
            cancel(timerId);
            timerId = null;
        }
        hasPending = false;
        pendingValue = undefined;
        disposeEffect();
    }, cancelPending, flushNow, pending);
}
