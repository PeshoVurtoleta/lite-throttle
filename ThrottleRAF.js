/**
 * ThrottleRAF.js -- leading + trailing throttle on a reactive source,
 * frame-aligned to requestAnimationFrame.
 *
 * State machine (per-instance):
 *   rafId          rAF handle, null when idle. (Was 0 pre-1.2; switched to
 *                  null so an injected `raf` that legitimately returns 0
 *                  is still recognised as armed.)
 *   hasPending     true if a change arrived inside the lockout
 *   pendingValue   most recent source value awaiting the trailing emission
 *
 * Per source change in steady state:
 *   1. read source, intent guard
 *   2. if rafId === null (not in lockout) -> leading emit, raf(flush)
 *   3. else -> queue trailing (pendingValue, hasPending = true)
 *
 * Re-entrancy: out.set is synchronous; a subscriber that writes back to the
 * source re-runs this effect inside the flush. The re-run sees rafId === null
 * (just cleared by flush) and takes the leading-edge branch -- that branch
 * does not touch hasPending or pendingValue, so the existing snapshot-style
 * flush is safe. The snapshot is still applied for symmetry with the timer
 * variant and to harden against future logic changes.
 *
 * One observable consequence of the re-entrancy path: if a subscriber writes
 * back to the source during the trailing fire, the consumer can see two
 * emissions in a single rAF flush -- first the trailing value, then the new
 * leading value. This is correct ("lockout just ended, new write is a fresh
 * leading edge"), but worth knowing if you write feedback loops.
 *
 * Allocation profile (per instance):
 *   At construction: 1 signal node, 1 effect node, links, plus four
 *   closures.
 *   Per source change (steady state): zero JS-heap allocations from this file.
 *   `raf` is called at most once per frame.
 *
 * Runtime (1.2):
 *   By default requires a host `requestAnimationFrame` /
 *   `cancelAnimationFrame`. Browser, Deno, and modern Node all expose these
 *   on globalThis. If neither is present at construction and no `raf` /
 *   `caf` were injected, the constructor throws with an actionable message.
 *   For tests, either inject `{ raf, caf }` explicitly, or stub the globals.
 *
 * Ownership cascade (1.2):
 *   See the note in Throttle.js. A synchronous `onCleanup(clearRafState)`
 *   at the end of the constructor attaches to the caller's currentOwner,
 *   so the pending rAF is cancelled when a parent scope disposes or re-runs.
 */

import { signal, effect, untrack, onCleanup } from "@zakkster/lite-signal";
import { makeReadonlyApi } from "./_shared.js";

/**
 * @template T
 * @typedef {object} ReadonlyDerivedExtras
 * @property {() => T} peek
 * @property {(fn: (value: T) => void) => () => void} subscribe
 * @property {() => void} dispose
 * @property {() => void} cancel
 * @property {() => T} flush
 * @property {() => boolean} pending
 */

/**
 * @template T
 * @typedef {(() => T) & ReadonlyDerivedExtras<T>} ReadonlyDerived
 */

/**
 * Leading + trailing throttle on a reactive source, aligned to
 * `requestAnimationFrame`.
 *
 * Emits the first change immediately, then suppresses further emissions until
 * the next animation frame fires. If any changes arrived during the frame,
 * the most recent value emits once at frame boundary (trailing edge).
 *
 * The output signal uses default `Object.is` equality. A leading or trailing
 * fire whose value matches the current output will not notify subscribers.
 *
 * Disposal: `api.dispose()` cancels any pending rAF and releases the effect.
 * The api is callable; do not pass it to `lite-signal.dispose`.
 *
 * @template T
 * @param {() => T} sourceFn  Tracked source.
 * @param {{
 *   leading?: boolean,
 *   trailing?: boolean,
 *   raf?: (cb: () => void) => unknown,
 *   caf?: (id: unknown) => void
 * }} [options]
 * @returns {ReadonlyDerived<T>}
 *
 * @example
 *   // Frame-aligned render of a chaotic input source
 *   const pointer = signal({ x: 0, y: 0 });
 *   const throttled = throttleRAF(() => pointer());
 *   effect(() => draw(throttled()));
 */
export function throttleRAF(sourceFn, {
    leading = true,
    trailing = true,
    raf,
    caf,
} = {}) {
    // Resolve raf/caf at construction. Fail fast with an actionable message
    // if unavailable -- previously, construction silently succeeded and the
    // first user-driven set() threw "requestAnimationFrame is not defined".
    if (raf === undefined) raf = globalThis.requestAnimationFrame;
    if (caf === undefined) caf = globalThis.cancelAnimationFrame;
    if (typeof raf !== "function" || typeof caf !== "function") {
        throw new Error(
            "throttleRAF: requestAnimationFrame / cancelAnimationFrame not available in this environment. " +
            "Either pass { raf, caf } explicitly, or use throttle(sourceFn, 16) as a timer-based fallback."
        );
    }

    const out = signal(untrack(sourceFn));

    let rafId = null;
    let hasPending = false;
    let pendingValue;

    const flush = () => {
        rafId = null;

        if (!hasPending) return;

        const v = pendingValue;
        hasPending = false;
        pendingValue = undefined;
        out.set(v);
    };

    const disposeEffect = effect(() => {
        const nextValue = sourceFn();
        const intent = hasPending ? pendingValue : out.peek();

        if (Object.is(nextValue, intent)) return;

        if (rafId === null) {
            // Frame is open.
            if (leading) {
                // Leading edge: emit now, hold the frame.
                out.set(nextValue);
                rafId = raf(flush);
            } else if (trailing) {
                // Leading suppressed: open a frame, emit the latest at its boundary.
                pendingValue = nextValue;
                hasPending = true;
                rafId = raf(flush);
            }
            // leading && trailing both false -> emit nothing (degenerate; documented).
        } else if (trailing) {
            // Inside the frame lockout: queue the trailing value.
            pendingValue = nextValue;
            hasPending = true;
        }
        // within frame, trailing disabled -> drop.
    });

    // Ownership-cascade cleanup (1.2). See Throttle.js for the full rationale.
    // Attaches to the caller's currentOwner at construction time; no-op at
    // top level.
    onCleanup(() => {
        if (rafId !== null) {
            caf(rafId);
            rafId = null;
        }
        hasPending = false;
        pendingValue = undefined;
    });

    const cancelPending = () => {                 // drop the pending trailing emission; output unchanged
        if (rafId !== null) { caf(rafId); rafId = null; }
        hasPending = false;
        pendingValue = undefined;
    };
    const flushNow = () => {                      // emit the pending trailing value synchronously now
        if (rafId !== null) { caf(rafId); rafId = null; }
        if (hasPending) {
            const v = pendingValue;
            hasPending = false;
            pendingValue = undefined;
            out.set(v);
        }
        return out.peek();
    };
    const pending = () => hasPending;             // 1.2

    return makeReadonlyApi(out, () => {
        // Direct dispose path: clear rAF state inline, then release. If the
        // caller's owner has already cascade-disposed us, this finds nothing
        // to clear (idempotent) and disposeEffect is a gen-guarded no-op.
        if (rafId !== null) { caf(rafId); rafId = null; }
        hasPending = false;
        pendingValue = undefined;
        disposeEffect();
    }, cancelPending, flushNow, pending);
}
