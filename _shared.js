/**
 * _shared.js -- internal helper, not part of the public API.
 *
 * Wraps a signal in a read-only callable api with .peek/.subscribe/.dispose,
 * plus optional .cancel/.flush (1.1) and .pending (1.2). Setup-time only;
 * the returned closures are allocated once per instance and reused indefinitely.
 *
 * Not re-exported from index.js. Kept in the published package because the
 * per-utility files import it at runtime; the "exports" field in package.json
 * blocks deep imports by consumers.
 */

/**
 * @template T
 * @param {import("@zakkster/lite-signal").Signal<T>} out
 * @param {() => void} dispose
 * @param {() => void} [cancel]  Drop any pending emission (1.1). Output unchanged.
 * @param {() => T} [flush]      Emit any pending value synchronously now (1.1).
 * @param {() => boolean} [pending] True iff a trailing emission is queued (1.2).
 * @returns {(() => T) & { peek: () => T; subscribe: (fn: (v: T) => void) => () => void; dispose: () => void; cancel?: () => void; flush?: () => T; pending?: () => boolean }}
 */
export function makeReadonlyApi(out, dispose, cancel, flush, pending) {
    const api = () => out();
    // bind() preserves the receiver. lite-signal's older builds implemented
    // peek/subscribe as closures (which work either way), but newer builds
    // use shared functions on a prototype-like dispatch that REQUIRE the
    // signal node as the receiver. Naked assignment of `out.peek` strips
    // that, so a later `api.peek()` crashes inside lite-signal trying to
    // read `this.value` on the wrong object. Binding at setup time is a
    // one-shot allocation per instance and immune to either implementation.
    api.peek = out.peek.bind(out);
    api.subscribe = out.subscribe.bind(out);
    api.dispose = dispose;
    if (cancel) api.cancel = cancel;
    if (flush) api.flush = flush;
    if (pending) api.pending = pending;
    return api;
}
