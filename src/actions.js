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

export class Action {
  execute() {
    throw new Error('execute() not implemented');
  }
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
    const dispatchFeed = new EventTarget();

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
            state,
          });
        } finally {
          await lease.release();
        }
      } catch (e) {
        error = e;
      } finally {
        // Phase 3: Unwind the stack in reverse.
        for (let i = enteredInterceptors.length - 1; i >= 0; i--) {
          const interceptor = enteredInterceptors[i];
          try {
            if (error && interceptor.error) {
              const errorContext = {
                dispatchFeed,
                engineFeed,
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

        if (error) {
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
