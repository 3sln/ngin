// The full stack: providers + actions + queries, wired together.
//
// `Engine` is a facade.  Everything it does is available from the three layers
// directly; it exists so the common case stays a one-liner.

import { Container } from './providers.js';
import { Dispatcher } from './actions.js';
import { QueryStore } from './queries.js';

export class Engine {
  #container;
  #dispatcher;
  #queries;
  #disposed = false;
  #disposal = null;

  constructor({ providers, interceptors, hooks, container, dispatcher, queries, pending } = {}) {
    // Each layer can be supplied pre-built, which is how you swap one out
    // (a stub container in tests, a dispatcher shared with another engine).
    this.#container = container ?? new Container({ providers });
    this.#dispatcher =
      dispatcher ?? new Dispatcher({ container: this.#container, interceptors });
    // The same interceptors wrap both: one list, one registration, and the
    // context names which kind of work a hook was called for (`action` or
    // `query`) for the interceptors that care about the difference.
    this.#queries =
      queries ??
      new QueryStore({
        container: this.#container,
        dispatcher: this.#dispatcher,
        interceptors,
        pending,
        createControllerMap: hooks?.createQueryControllersMap,
      });
  }

  get container() {
    return this.#container;
  }

  get dispatcher() {
    return this.#dispatcher;
  }

  get queries() {
    return this.#queries;
  }

  get feed() {
    return this.#container.feed;
  }

  // Dispatch an action.
  dispatch(actionInstance) {
    if (this.#disposed) {
      throw new Error('The engine has been disposed');
    }
    return this.#dispatcher.dispatch(actionInstance);
  }

  // Realizes a query as a Cell (with deprecated subscribe/peek compatibility).
  query(queryInstance) {
    if (this.#disposed) {
      throw new Error('The engine has been disposed');
    }
    return this.#queries.query(queryInstance);
  }

  dispose() {
    if (this.#disposal) {
      return this.#disposal;
    }
    this.#disposed = true;

    this.#disposal = (async () => {
      // Queries may dispatch lifecycle actions while shutting down. Drain those
      // and every earlier action before destroying their providers.
      await this.#queries.dispose();
      await this.#dispatcher.dispose?.();
      await this.#container.dispose();
    })();
    return this.#disposal;
  }
}
