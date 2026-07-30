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

  constructor({ providers, interceptors, hooks, container, dispatcher, queries } = {}) {
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
    return this.#dispatcher.dispatch(actionInstance);
  }

  // Realizes a query.
  query(queryInstance) {
    return this.#queries.query(queryInstance);
  }

  async dispose() {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;

    // Queries first: killing them releases resources back to the providers
    // that are about to be disposed.
    await this.#queries.dispose();
    await this.#container.dispose();
  }
}
