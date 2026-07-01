/**
 * Type declarations for @zakkster/lite-throttle.
 *
 * The returned api is a callable: invoking it performs a tracked read of the
 * internal signal. .peek() reads without tracking, .subscribe(fn) returns an
 * unsubscribe handle, .dispose() tears down the effect and releases the node.
 */

export interface ReadonlyDerived<T> {
    (): T;
    peek(): T;
    subscribe(fn: (value: T) => void): () => void;
    dispose(): void;
    /** Drop any pending trailing emission; the output keeps its current value. (1.1) */
    cancel(): void;
    /** Emit any pending trailing value synchronously now; returns the current output. (1.1) */
    flush(): T;
    /** True iff a trailing emission is currently queued. Cheap; safe to poll. (1.2) */
    pending(): boolean;
}

export interface ThrottleOptions {
    /** Emit on the leading edge of each window. Default true. (1.1) */
    leading?: boolean;
    /** Emit the most recent value on the trailing edge of each window. Default true. (1.1) */
    trailing?: boolean;
    /**
     * Clock reader. Defaults to `() => performance.now()`. Only consulted on
     * the potential-leading-edge branch (once `timerId === null`); the
     * inside-lockout hot path never calls this. (1.2)
     */
    now?: () => number;
    /**
     * Scheduler. Defaults to `setTimeout`. Called at most once per lockout
     * window. Returned handle is passed unchanged to `cancel` when the
     * pending emission is dropped or flushed early. (1.2)
     */
    schedule?: (fn: () => void, ms: number) => unknown;
    /** Cancels a handle returned by `schedule`. Defaults to `clearTimeout`. (1.2) */
    cancel?: (id: unknown) => void;
}

export interface ThrottleRAFOptions {
    /** Emit on the leading edge of each frame. Default true. (1.1) */
    leading?: boolean;
    /** Emit the most recent value at the frame boundary. Default true. (1.1) */
    trailing?: boolean;
    /**
     * requestAnimationFrame implementation. Defaults to
     * `globalThis.requestAnimationFrame`. Enables headless tests and
     * custom time domains (game engines, playback scrubbers) without
     * global monkey-patching. (1.2)
     */
    raf?: (cb: () => void) => unknown;
    /** cancelAnimationFrame implementation. Defaults to `globalThis.cancelAnimationFrame`. (1.2) */
    caf?: (id: unknown) => void;
}

/**
 * Leading and/or trailing throttle on a reactive source.
 * @param sourceFn Tracked source.
 * @param ms Lockout window in milliseconds. Accepts a function for a dynamic
 *   window (1.2); the reader is called via untrack at each potential leading
 *   edge, so signal changes to the window itself do not re-run the effect.
 * @param options Edge selection, custom clock, and custom scheduler.
 */
export function throttle<T>(
    sourceFn: () => T,
    ms: number | (() => number),
    options?: ThrottleOptions,
): ReadonlyDerived<T>;

/**
 * Leading and/or trailing throttle aligned to requestAnimationFrame.
 * @param sourceFn Tracked source.
 * @param options Edge selection and custom raf/caf.
 * @throws If no `requestAnimationFrame` / `cancelAnimationFrame` are available
 *   on globalThis and none were injected via `options.raf` / `options.caf`.
 */
export function throttleRAF<T>(
    sourceFn: () => T,
    options?: ThrottleRAFOptions,
): ReadonlyDerived<T>;
