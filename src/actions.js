// Layer 2: actions and interceptors.
//
// Depends only on the container seam (`feed`, `resolve`, `lease`, `use`), so it
// can be used with providers but without queries.

import { Container } from './providers.js';

// `ErrorEvent` is not a global everywhere JavaScript runs, so fall back to an
// equivalent shape.  Listeners read `event.error` either way.
const DispatchErrorEvent =
  typeof ErrorEvent === 'function'
    ? ErrorEvent
    : class DispatchErrorEvent extends Event {
        constructor(type, { error, message = '' } = {}) {
          super(type);
          this.error = error;
          this.message = message;
        }
      };

function messageOf(error) {
  return error && typeof error.message === 'string' ? error.message : String(error);
}

// The event an aborted dispatch ends on.  `reason` is what `abort()` was given;
// `error` is set only if the action threw on its way out, so nothing is lost by
// reporting the abort instead of the throw.
class DispatchAbortEvent extends Event {
  constructor({ reason, error = null } = {}) {
    super('abort');
    this.reason = reason;
    this.error = error;
  }
}

// How a dispatch can end.  All three are terminal: exactly one fires, once.
const TERMINAL = ['complete', 'error', 'abort'];

// What `abort()` uses when given no reason.  The same shape an AbortController
// picks for itself, so `feed.reason` and `signal.reason` agree; `DOMException`
// is not a global absolutely everywhere, hence the fallback.
function abortError() {
  return typeof DOMException === 'function'
    ? new DOMException('The dispatch was aborted', 'AbortError')
    : Object.assign(new Error('The dispatch was aborted'), { name: 'AbortError' });
}

export class Action {
  execute() {
    throw new Error('execute() not implemented');
  }
}

// The channel a dispatch reports on.
//
// Still an EventTarget, and still the only way results leave an action -- an
// action that emits `progress` five times and then `result` is saying more than
// a return value could.  Two things are layered on top:
//
//   feed.abort(reason)  -- the caller is no longer interested.  `signal` is
//                          handed to the action and its interceptors, so the
//                          work can stop; cooperatively, since nothing can
//                          interrupt a running function.
//   feed.next(names)    -- await one of `names`.  This is the shape a request
//                          handler wants: dispatch, await the event that
//                          carries the answer, reply.
//
// A dispatch ends on exactly one of `complete`, `error` or `abort`.  An aborted
// one ends on `abort` and never on `complete`, because a scan that was stopped
// at thirty percent did not complete, and saying it did is how "it worked" gets
// reported about work that did not happen.
//
// `next` treats all three as terminal unless you ask for one by name.  A promise
// that never settles is the worst thing this could do to a caller -- there is no
// timeout, no cancellation, and no error to log -- and an action that ends
// without emitting what was awaited would otherwise hang it forever.
export class DispatchFeed extends EventTarget {
  #controller = new AbortController();
  #reason; // why this was aborted -- see abort()
  #settled = null; // { type, event } once complete/error has fired

  constructor() {
    super();
    // Registered before any caller's listener, so `settled` is already true by
    // the time their handler runs. This is what lets `next()` answer a caller
    // that arrives after the action is over instead of waiting for an event
    // that can no longer fire.
    for (const type of TERMINAL) {
      this.addEventListener(
        type,
        (event) => { this.#settled ??= { type, event }; },
        { once: true }
      );
    }
  }

  // Aborted when the caller gives up. Handed to the action, and to every
  // interceptor, as `signal`.
  get signal() {
    return this.#controller.signal;
  }

  // The terminal event, if the dispatch is over: `'complete'`, `'error'`, or
  // null while it is still running.
  get settled() {
    return this.#settled?.type ?? null;
  }

  // Why this was aborted, once it has been.  Held here rather than read back off
  // `signal.reason` at the point of use: that value belongs to the runtime, and
  // it is what `next()` rejects with, so it must never come back undefined --
  // rejecting with `undefined` breaks every caller that writes `catch (e) {
  // e.message }`.  (Bun 1.3 does drop it under memory pressure; even without
  // that, the guarantee is cheaper to make than to depend on.)
  get reason() {
    return this.#reason;
  }

  // Stop caring about this dispatch.  The action decides when to notice --
  // there is no way to interrupt a running function -- but anything waiting on
  // `next()` rejects at once, because the point of aborting is not to wait.
  abort(reason) {
    if (this.#controller.signal.aborted) {
      return; // first abort wins, as with AbortController
    }
    // Recorded BEFORE aborting.  `abort()` dispatches synchronously, so a
    // `next()` waiting on the signal rejects during this call -- with the reason
    // if it is already here, and with undefined if it is not.
    this.#reason = reason ?? abortError();
    this.#controller.abort(this.#reason);
  }

  /**
   * Resolve with the first of `names` to fire.
   *
   * @param {string|string[]} names event name, or names, to wait for
   * @param {{signal?: AbortSignal}} [options] the caller's own cancellation,
   *   separate from `feed.abort()` -- an HTTP handler passes the request's
   *   signal here so a disconnect unblocks it without aborting the action.
   * @returns {Promise<Event>} the event that fired
   */
  next(names, { signal } = {}) {
    const wanted = new Set(Array.isArray(names) ? names : [names]);
    if (wanted.size === 0) {
      throw new TypeError('next() requires at least one event name');
    }

    // Aborting and then awaiting `abort` is the ordinary wind-down: you have
    // stopped caring about the answer but still need to know the work stopped,
    // to release something or to reply.  So a wait for the abort event is not
    // pre-empted by the abort itself -- everything else is, because the point of
    // giving up is not to keep waiting for the action to notice.
    const awaitingTheEnd = wanted.has('abort');

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      if (this.#controller.signal.aborted && !awaitingTheEnd && !this.#settled) {
        reject(this.#reason);
        return;
      }
      // Already over.  Answer from what was recorded rather than waiting for an
      // event that has fired once and will not fire again.
      if (this.#settled) {
        this.#finish(resolve, reject, this.#settled, wanted);
        return;
      }

      // One controller unregisters every listener below at once, on whichever
      // path settles first.
      const stop = new AbortController();
      const options = { signal: stop.signal };
      const settle = (fn) => (value) => {
        stop.abort();
        fn(value);
      };

      for (const name of wanted) {
        this.addEventListener(name, settle(resolve), options);
      }
      // Every terminal event not asked for by name ends the wait, because after
      // one of them nothing else will ever fire.
      for (const type of TERMINAL) {
        if (wanted.has(type)) {
          continue;
        }
        this.addEventListener(
          type,
          (event) => settle(reject)(endedWithout(type, event, wanted)),
          options
        );
      }
      if (!awaitingTheEnd) {
        this.#controller.signal.addEventListener(
          'abort',
          () => settle(reject)(this.#reason),
          options
        );
      }
      signal?.addEventListener('abort', () => settle(reject)(signal.reason), options);
    });
  }

  #finish(resolve, reject, settled, wanted) {
    if (wanted.has(settled.type)) {
      resolve(settled.event);
    } else {
      reject(endedWithout(settled.type, settled.event, wanted));
    }
  }
}

// Why a wait ended without what it was waiting for.  The action's own error and
// the abort reason are handed back unwrapped, so a caller mapping them onto
// something else -- an HTTP status, say -- still can.
function endedWithout(type, event, wanted) {
  if (type === 'error') {
    return event.error;
  }
  if (type === 'abort') {
    return event.reason;
  }
  return missing(wanted);
}

function missing(wanted) {
  return new Error(
    `The dispatch completed without emitting ${[...wanted].map((n) => `'${n}'`).join(' or ')}`
  );
}

// Runs actions through a stack of interceptors.
export class Dispatcher {
  #container;
  #interceptors;

  constructor({ container, interceptors } = {}) {
    this.#container = container ?? new Container();
    this.#interceptors = interceptors ? [...interceptors] : [];
  }

  get container() {
    return this.#container;
  }

  get feed() {
    return this.#container.feed;
  }

  // Dispatch an action.  Returns the dispatch feed immediately; the action
  // itself runs on a later turn of the event loop.
  dispatch(actionInstance) {
    if (!(actionInstance instanceof Action)) {
      throw new TypeError('dispatch() requires an instance of Action');
    }

    const container = this.#container;
    const interceptors = this.#interceptors;
    const engineFeed = container.feed;
    const dispatchFeed = new DispatchFeed();

    setTimeout(async () => {
      const enteredInterceptors = [];
      let state = {};
      let error = null;

      const applyState = (nextState) => {
        if (nextState !== undefined) {
          state = nextState;
        }
      };

      try {
        // Phase 1: Run 'enter' interceptors.
        for (const interceptor of interceptors) {
          // Recorded before running so a failing 'enter' still gets unwound.
          enteredInterceptors.push(interceptor);
          if (!interceptor.enter) {
            continue;
          }

          applyState(
            await container.use(interceptor.deps, (resources) =>
              interceptor.enter(resources, {
                dispatchFeed,
                engineFeed,
                signal: dispatchFeed.signal,
                state,
                action: actionInstance,
              })
            )
          );
        }

        // Phase 2: Obtain and execute the main action.  Instance deps override
        // static ones of the same name.
        const lease = await container.lease(
          actionInstance.constructor.deps,
          actionInstance.deps
        );
        try {
          await actionInstance.execute(lease.resources, {
            dispatchFeed,
            engineFeed,
            // Cooperative: aborting cannot interrupt a running function, so an
            // action that wants to be stoppable checks this, or hands it to
            // something that does (fetch, a scan loop, another dispatch).
            signal: dispatchFeed.signal,
            state,
          });
        } finally {
          await lease.release();
        }
      } catch (e) {
        error = e;
      } finally {
        // Phase 3: Unwind the stack in reverse.
        //
        // Every interceptor that entered gets exactly ONE unwind call.  That is
        // what makes it safe to acquire something in `enter`, so `abort` falls
        // back to the hook that would have run without it rather than to
        // nothing -- an interceptor that does not know about aborting must
        // still be given the chance to close what it opened.
        //
        //   aborted   -> abort ?? (error ? error : leave)
        //   error     -> error ?? nothing
        //   otherwise -> leave ?? nothing
        //
        // Which matters because of what `leave` means to the obvious
        // interceptor: enter/begin, leave/commit, error/rollback.  Without an
        // `abort` hook that one commits the work of a dispatch that was
        // cancelled half way through -- the same lie the feed used to tell by
        // ending an aborted dispatch on `complete`.
        for (let i = enteredInterceptors.length - 1; i >= 0; i--) {
          const interceptor = enteredInterceptors[i];
          // Read per iteration: an abort landing mid-unwind is reflected by the
          // interceptors that have not run yet, rather than being missed.
          const aborted = dispatchFeed.signal.aborted;
          try {
            if (aborted && interceptor.abort) {
              applyState(
                await container.use(interceptor.deps, (resources) =>
                  interceptor.abort(resources, {
                    dispatchFeed,
                    engineFeed,
                    signal: dispatchFeed.signal,
                    action: actionInstance,
                    state,
                    reason: dispatchFeed.reason,
                    // Set when the action threw on its way out -- usually
                    // because it honoured the signal.  There is no `handled()`
                    // here: a cancellation cannot be handled into a success,
                    // because the work did not happen.
                    error,
                  })
                )
              );
            } else if (error && interceptor.error) {
              const errorContext = {
                dispatchFeed,
                engineFeed,
                signal: dispatchFeed.signal,
                action: actionInstance,
                state,
                error,
                handled: () => {
                  error = null;
                },
              };
              applyState(
                await container.use(interceptor.deps, (resources) =>
                  interceptor.error(resources, errorContext)
                )
              );
            } else if (!error && interceptor.leave) {
              applyState(
                await container.use(interceptor.deps, (resources) =>
                  interceptor.leave(resources, {
                    dispatchFeed,
                    engineFeed,
                    signal: dispatchFeed.signal,
                    state,
                    action: actionInstance,
                  })
                )
              );
            }
          } catch (e) {
            error = e;
          }
        }

        // An aborted dispatch ends on `abort`, whatever the action did on its
        // way out. It did not complete -- it was stopped -- and an action that
        // threw because it honoured the signal threw *because* of the abort, so
        // reporting the throw would name the symptom rather than the cause. The
        // error is carried on the event either way, so nothing is lost.
        if (dispatchFeed.signal.aborted) {
          dispatchFeed.dispatchEvent(
            new DispatchAbortEvent({ reason: dispatchFeed.reason, error })
          );
        } else if (error) {
          dispatchFeed.dispatchEvent(
            new DispatchErrorEvent('error', { error, message: messageOf(error) })
          );
        } else {
          dispatchFeed.dispatchEvent(new Event('complete'));
        }
      }
    });

    return dispatchFeed;
  }
}
