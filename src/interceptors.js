// Shared internals: the interceptor stack.  Not part of the public API.
//
// An interceptor wraps work.  It is entered on the way in and unwound exactly
// once on the way out, and the rules for which unwind hook runs are the same
// whether that work is a dispatch or a query -- so they live here rather than
// in both layers.  This module knows only the container seam (`use`), so it
// keeps actions and queries siblings: neither imports the other to get at it.
//
// What differs is what is being wrapped, and the context says so by name: a
// dispatch hands over `action`, a query hands over `query`.  An interceptor
// that counts, times, or checks access can ignore the difference and be
// registered once for both; one that reaches into the work it is wrapping
// switches on which of the two keys is there.
//
// Two shapes of work use this:
//
//   dispatch, one-shot fetch  enter, work, unwind -- all in one go, `run()`
//   live query                enter at boot, unwind at kill, minutes apart
//
// which is why `enter` and `unwind` are separate calls, with `run` layered on
// top for the sites that do both at once.

export class InterceptorStack {
  #container;
  #interceptors;
  #context;
  #aborted;

  #entered = [];
  #state = {};
  #error = null;

  /**
   * @param {object} options
   * @param {{use: Function}} options.container the container seam.  Each hook
   *   gets a scoped lease of its own `deps`, held for that call only.
   * @param {object[]} [options.interceptors] the stack, outermost first.  Held
   *   by reference: the site owns the list and is the one that copies it, so
   *   that "the list is copied at construction time" means the site's
   *   construction rather than each dispatch's.
   * @param {() => object} options.context the site's own context fields, built
   *   fresh for every hook call -- so one that appears part way through, like a
   *   query's `killFeed`, is there by the time it exists.
   * @param {() => ({reason: any}|null)} [options.aborted] null while the work
   *   is still wanted, `{ reason }` once it has been abandoned.  Called again
   *   before every unwind step, so an abort landing mid-unwind is reflected by
   *   the interceptors that have not run yet rather than being missed.  A query
   *   has nothing to abort and leaves it at the default.
   */
  constructor({ container, interceptors = [], context, aborted = () => null }) {
    this.#container = container;
    this.#interceptors = interceptors;
    this.#context = context;
    this.#aborted = aborted;
  }

  // What the interceptors have threaded through so far: whatever the last hook
  // to return something returned.  The site hands this to the work itself, so
  // an action's `execute` and a query's `boot` see what was put there.
  get state() {
    return this.#state;
  }

  // Nothing to enter and nothing to unwind.  Worth asking, because awaiting
  // even an already-settled promise costs a turn of the event loop: a query
  // that awaited an empty `enter()` would dispatch its boot action a tick later
  // than it does with no interceptor machinery at all.  Sites that are
  // sensitive to that check this first; the hooks themselves are no-ops either
  // way.
  get empty() {
    return this.#interceptors.length === 0;
  }

  // Enter every interceptor, in order.  Rethrows what a failing `enter` threw,
  // having recorded that interceptor as entered first, so `unwind` still gives
  // it -- and everything outside it -- its one hook.
  async enter() {
    for (const interceptor of this.#interceptors) {
      this.#entered.push(interceptor);
      if (!interceptor.enter) {
        continue;
      }
      await this.#call(interceptor, 'enter');
    }
  }

  /**
   * Unwind the stack in reverse.
   *
   * Every interceptor that entered gets exactly ONE unwind call.  That is what
   * makes it safe to acquire something in `enter`, so `abort` falls back to the
   * hook that would have run without it rather than to nothing -- an
   * interceptor that does not know about aborting must still be given the
   * chance to close what it opened.
   *
   *   aborted   -> abort ?? (error ? error : leave)
   *   error     -> error ?? nothing
   *   otherwise -> leave ?? nothing
   *
   * Which matters because of what `leave` means to the obvious interceptor:
   * enter/begin, leave/commit, error/rollback.  Without an `abort` hook that
   * one commits the work of a dispatch that was cancelled half way through.
   *
   * @param {any} [error] what the work failed with, if it failed.
   * @returns {any} the error the site should end on: null if there was none, or
   *   if an `error` hook called `handled()`, and whatever an unwinding hook
   *   threw on its own way out otherwise.
   */
  async unwind(error) {
    if (error !== undefined) {
      this.#error = error;
    }

    // Taken, not read, so "exactly one unwind call per interceptor that
    // entered" holds for the stack itself rather than resting on every site
    // calling this exactly once.  A second unwind finds nothing to do.
    const entered = this.#entered;
    this.#entered = [];

    for (let i = entered.length - 1; i >= 0; i--) {
      const interceptor = entered[i];
      const aborted = this.#aborted();
      try {
        if (aborted && interceptor.abort) {
          await this.#call(interceptor, 'abort', {
            reason: aborted.reason,
            // Set when the work threw on its way out -- usually because it
            // honoured the signal.  There is no `handled()` here: a
            // cancellation cannot be handled into a success, because the work
            // did not happen.
            error: this.#error,
          });
        } else if (this.#error && interceptor.error) {
          await this.#call(interceptor, 'error', {
            error: this.#error,
            handled: () => {
              this.#error = null;
            },
          });
        } else if (!this.#error && interceptor.leave) {
          await this.#call(interceptor, 'leave');
        }
      } catch (err) {
        this.#error = err;
      }
    }

    return this.#error;
  }

  /**
   * Enter, run `work`, unwind -- for work that happens in one go: a dispatch,
   * a one-shot query's fetch.
   *
   * @param {(state: object) => any} work given the state the interceptors
   *   threaded through their `enter` hooks.
   * @returns {Promise<any>} whatever `work` returned, untouched.  Interceptors
   *   wrap the work; they have no say in its result.
   * @throws whatever the unwind ended on, which is `work`'s own error unless an
   *   `error` hook handled it or an unwinding hook threw something else.
   */
  async run(work) {
    let value;
    let error;

    try {
      await this.enter();
      value = await work(this.#state);
    } catch (err) {
      error = err;
    }

    const failure = await this.unwind(error);
    if (failure) {
      throw failure;
    }
    return value;
  }

  async #call(interceptor, hook, extra) {
    const next = await this.#container.use(interceptor.deps, (resources) =>
      interceptor[hook](resources, { ...this.#context(), state: this.#state, ...extra })
    );
    // A hook that returns nothing leaves the state alone; one that returns
    // something replaces it for every hook and every piece of work after it.
    if (next !== undefined) {
      this.#state = next;
    }
  }
}
