// Layer 3: queries.
//
// Depends on the container seam, and optionally on *anything* with a
// `dispatch(action)` method for queries that declare a `bootAction` or
// `killAction`.  It does not import the actions layer, so queries can be used
// with providers alone.

import { Container } from './providers.js';
import { report } from './internal.js';

export class Query {
  boot() {
    throw new Error('boot() not implemented');
  }
  kill() {}
}

// One live realization of a query instance, shared by all of its observers.
class QueryController {
  #store;
  #query;
  #lease = null;
  #booting = null;
  #booted = false;
  #killing = null;
  #received = Promise.withResolvers();
  #hasValue = false;
  #currentValue = undefined;
  #dead = false;
  #bootFeed = undefined;
  #killFeed = undefined;

  observers = new Set();

  constructor(store, query) {
    this.#store = store;
    this.#query = query;
    this.notify = this.notify.bind(this);
  }

  get hasValue() {
    return this.#hasValue;
  }

  get currentValue() {
    return this.#currentValue;
  }

  // Resolves true once a value has arrived, false if the query died first.
  get received() {
    return this.#received.promise;
  }

  get bootFeed() {
    return this.#bootFeed;
  }

  get killFeed() {
    return this.#killFeed;
  }

  notify(nextValue) {
    if (this.#dead) {
      return;
    }

    this.#currentValue = nextValue;

    if (!this.#hasValue) {
      this.#hasValue = true;
      this.#received.resolve(true);
    }

    // Copied so an observer unsubscribing mid-notify doesn't skip its peers.
    for (const observer of [...this.observers]) {
      try {
        observer.next?.(nextValue);
      } catch (err) {
        report(err);
      }
    }
  }

  boot() {
    if (this.#booting) {
      return this.#booting;
    }

    this.#booting = (async () => {
      try {
        if (this.#query.bootAction) {
          this.#bootFeed = this.#store._dispatch(this.#query.bootAction);
        }

        this.#lease = await this.#store._container.lease(
          this.#query.constructor.deps,
          this.#query.deps
        );

        await this.#query.boot?.(this.#lease.resources, {
          notify: this.notify,
          engineFeed: this.#store._container.feed,
          bootFeed: this.#bootFeed,
        });
      } catch (err) {
        report(err);
        // A query that failed to boot is not a query anyone can wait on.
        await this.#teardown();
      } finally {
        this.#booted = true;
      }
    })();

    return this.#booting;
  }

  kill() {
    if (this.#killing) {
      return this.#killing;
    }

    // Never tear down on top of an in-flight boot -- but when boot has already
    // settled, run the teardown eagerly rather than punting it to a later tick.
    this.#killing = this.#booted
      ? this.#runKill()
      : Promise.resolve(this.#booting).then(() => this.#runKill());

    return this.#killing;
  }

  async #runKill() {
    if (this.#dead) {
      return;
    }

    try {
      if (this.#query.killAction) {
        this.#killFeed = this.#store._dispatch(this.#query.killAction);
      }
      if (this.#query.kill) {
        await this.#query.kill(this.#lease?.resources ?? {}, {
          bootFeed: this.#bootFeed,
          killFeed: this.#killFeed,
          engineFeed: this.#store._container.feed,
          notify: this.notify,
        });
      }
    } catch (err) {
      report(err);
    } finally {
      await this.#teardown();
    }
  }

  async #teardown() {
    if (this.#dead) {
      return;
    }
    this.#dead = true;

    this.#store._evict(this.#query, this);

    const observers = [...this.observers];
    this.observers.clear();
    for (const observer of observers) {
      try {
        observer.complete?.();
      } catch (err) {
        report(err);
      }
    }

    if (!this.#hasValue) {
      this.#received.resolve(false);
    }

    const lease = this.#lease;
    this.#lease = null;
    if (lease) {
      await lease.release();
    }
  }
}

// Realizes queries and keeps one live controller per query instance.
export class QueryStore {
  #container;
  #dispatcher;
  #controllers;
  #disposed = false;

  constructor({ container, dispatcher, createControllerMap } = {}) {
    this.#container = container ?? new Container();
    this.#dispatcher = dispatcher ?? null;
    this.#controllers = createControllerMap?.() ?? new Map();
  }

  get container() {
    return this.#container;
  }

  get feed() {
    return this.#container.feed;
  }

  // Internal seams used by QueryController.
  get _container() {
    return this.#container;
  }

  _dispatch(action) {
    if (!this.#dispatcher) {
      throw new Error(
        'A query declared a bootAction/killAction but no dispatcher was given to QueryStore'
      );
    }
    return this.#dispatcher.dispatch(action);
  }

  _evict(queryInstance, controller) {
    if (this.#controllers.get(queryInstance) === controller) {
      this.#controllers.delete(queryInstance);
    }
  }

  #queryDeps(queryInstance) {
    return [queryInstance.constructor.deps, queryInstance.deps];
  }

  // Realizes a query.  Call `subscribe` on the returned object to use it as an
  // RxJS style observable, or `peek` to get a look at the current value if the
  // query is active, or fetch it otherwise.
  query(queryInstance) {
    if (!(queryInstance instanceof Query)) {
      throw new TypeError('query() requires an instance of Query');
    }

    return {
      subscribe: (observerOrNext) => {
        if (this.#disposed) {
          throw new Error('The query store has been disposed');
        }

        const observer =
          typeof observerOrNext === 'function'
            ? { next: observerOrNext }
            : observerOrNext || {};

        let controller = this.#controllers.get(queryInstance);
        if (controller) {
          controller.observers.add(observer);
          if (controller.hasValue) {
            try {
              observer.next?.(controller.currentValue);
            } catch (err) {
              report(err);
            }
          }
        } else {
          controller = new QueryController(this, queryInstance);
          this.#controllers.set(queryInstance, controller);
          controller.observers.add(observer);
          controller.boot();
        }

        let closed = false;
        return {
          get closed() {
            return closed;
          },
          unsubscribe: () => {
            if (closed) {
              return;
            }
            closed = true;

            controller.observers.delete(observer);
            if (controller.observers.size === 0) {
              // Dropped from the registry first, so a subscribe that arrives
              // while the controller is dying gets a fresh one.
              this._evict(queryInstance, controller);
              controller.kill();
            }
          },
        };
      },

      peek: async () => {
        const controller = this.#controllers.get(queryInstance);
        if (controller && (await controller.received)) {
          return controller.currentValue;
        }

        if (typeof queryInstance.fetch !== 'function') {
          throw new TypeError(
            `${queryInstance.constructor.name} is not active and does not implement fetch()`
          );
        }

        const lease = await this.#container.lease(...this.#queryDeps(queryInstance));
        try {
          return await queryInstance.fetch(lease.resources, {
            engineFeed: this.#container.feed,
            bootFeed: controller?.bootFeed,
            killFeed: controller?.killFeed,
          });
        } finally {
          await lease.release();
        }
      },
    };
  }

  // Kills every live query.  Idempotent.
  async dispose() {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;

    // A custom controller map is not required to be enumerable.
    for (const controller of [...(this.#controllers.values?.() ?? [])]) {
      await controller.kill();
    }
  }
}
