// Layer 3: queries.
//
// Depends on the container seam, and optionally on *anything* with a
// `dispatch(action)` method for queries that declare a `bootAction` or
// `killAction`.  It does not import the actions layer, so queries can be used
// with providers alone -- the interceptor machinery the two layers share is a
// module of its own for exactly that reason.

import { Container } from './providers.js';
import { InterceptorStack } from './interceptors.js';
import { report } from './internal.js';

// The Cell owns one upstream observer regardless of its listener count. Legacy
// observers still use that same controller through subscribe(). Reads never
// connect or fetch: only the first dirty listener starts a realization.
function asCell(handle, readActive, assertAvailable) {
  const listeners = new Set();
  let subscription = null;
  let value;
  let received = false;
  let failed = false;
  let failure;

  const notify = () => {
    for (const { listener } of [...listeners]) {
      try {
        listener();
      } catch (err) {
        report(err);
      }
    }
  };

  return Object.assign(handle, {
    onDirty(listener) {
      assertAvailable();
      if (typeof listener !== 'function') {
        throw new TypeError('onDirty() requires a function');
      }
      // Each registration counts independently, including duplicate callbacks.
      const registration = { listener };
      listeners.add(registration);
      if (listeners.size === 1) {
        value = undefined;
        received = false;
        failed = false;
        failure = undefined;
        try {
          subscription = handle.subscribe({
            next(nextValue) {
              value = nextValue;
              received = true;
              failed = false;
              failure = undefined;
              notify();
            },
            error(error) {
              failed = true;
              failure = error;
              notify();
            },
          });
        } catch (err) {
          listeners.delete(registration);
          throw err;
        }
      }
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        listeners.delete(registration);
        if (listeners.size === 0 && subscription) {
          const previous = subscription;
          subscription = null;
          previous.unsubscribe();
        }
      };
    },
    hasValue() {
      const active = readActive();
      if (active) return active.hasValue;
      if (failed) throw failure;
      return received;
    },
    getValue() {
      const active = readActive();
      if (active) return active.currentValue;
      if (failed) throw failure;
      return value;
    },
  });
}

export class Query {
  // A query that implements `fetch` and not `boot` is a ONE-SHOT: subscribing to
  // it fetches once, hands the value over, and completes.  See QueryController's
  // boot() for why that is the fallback rather than an error.
  boot() {
    throw new Error('boot() not implemented, and no fetch() to fall back to');
  }
  kill() {}
}

// One live realization of a query instance, shared by all of its observers.
//
// Interceptors wrap it the way they wrap a dispatch, stretched over its
// lifetime: `enter` before it boots, `leave` when it dies.  For a live query
// that is boot until kill; for a one-shot it is the length of the fetch, which
// is the same shape a dispatch has.
class QueryController {
  #store;
  #query;
  #stack;
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
    this.#stack = new InterceptorStack({
      container: store._container,
      interceptors: store._interceptors,
      // Built per hook, so `killFeed` is there for the hooks that run after the
      // kill action was dispatched and absent for the ones before it.  `notify`
      // is deliberately not here: an interceptor wraps a query, it does not get
      // to emit on its behalf.
      context: () => ({
        query: this.#query,
        engineFeed: this.#store._container.feed,
        bootFeed: this.#bootFeed,
        killFeed: this.#killFeed,
      }),
    });
  }

  get hasValue() {
    return this.#hasValue;
  }

  get currentValue() {
    return this.#currentValue;
  }

  // Resolves true once a value has arrived, false if the query died first.
  // A live query that never notifies leaves this pending -- that is what makes
  // peek() on such a query wait rather than fall back to fetch().
  get received() {
    return this.#received.promise;
  }

  get bootFeed() {
    return this.#bootFeed;
  }

  get killFeed() {
    return this.#killFeed;
  }

  // A lifecycle action is fire-and-forget -- nothing is waiting on its feed, so
  // a failure would otherwise vanish.  Route it to the same channel as every
  // other unpropagatable error, with enough context to place it.
  #dispatchLifecycleAction(action, label) {
    const feed = this.#store._dispatch(action);

    feed.addEventListener(
      'error',
      (event) => {
        report(
          new Error(
            `${this.#query.constructor.name} ${label} (${action.constructor.name}) failed`,
            { cause: event.error }
          )
        );
      },
      { once: true }
    );

    return feed;
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
        // Before anything else happens on the query's behalf.  An interceptor
        // that refuses one -- an access check -- has to be able to do so before
        // its boot action is dispatched and its resources are leased.  Which
        // does put the rest of the boot on a later turn, so a query with no
        // interceptors skips the await entirely rather than paying for a stack
        // it does not have.
        if (!this.#stack.empty) {
          await this.#stack.enter();
        }

        if (this.#query.bootAction) {
          this.#bootFeed = this.#dispatchLifecycleAction(
            this.#query.bootAction,
            'bootAction'
          );
        }

        this.#lease = await this.#store._container.lease(
          this.#query.constructor.deps,
          this.#query.deps
        );

        const context = {
          notify: this.notify,
          engineFeed: this.#store._container.feed,
          bootFeed: this.#bootFeed,
          // Whatever the interceptors threaded through, the same as an action's
          // `execute` gets.
          state: this.#stack.state,
        };

        // A query that never overrode `boot` is a read: it has one answer and no
        // way to learn of a second.  Rather than failing -- which is what the
        // base `boot` would do, and it failed QUIETLY, leaving the subscriber
        // waiting for a value that was never coming -- fetch once, hand the
        // value over, and complete.  That is an ordinary single-value
        // observable, so a consumer can subscribe to any query without knowing
        // in advance whether it is live.
        if (this.#query.boot === Query.prototype.boot) {
          if (typeof this.#query.fetch !== 'function') {
            throw new Error(
              `${this.#query.constructor.name} implements neither boot() nor fetch()`
            );
          }
          this.notify(await this.#query.fetch(this.#lease.resources, context));
          // Evicts, completes every observer, and releases the lease -- and
          // evicting is what makes the NEXT subscribe fetch again rather than
          // serving a value that has no way of ever being refreshed.
          await this.#teardown();
        } else {
          await this.#query.boot(this.#lease.resources, context);
        }
      } catch (err) {
        report(err);
        // A query that failed to boot is not a query anyone can wait on.
        await this.#teardown(err);
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
        this.#killFeed = this.#dispatchLifecycleAction(
          this.#query.killAction,
          'killAction'
        );
      }
      if (this.#query.kill) {
        await this.#query.kill(this.#lease?.resources ?? {}, {
          bootFeed: this.#bootFeed,
          killFeed: this.#killFeed,
          engineFeed: this.#store._container.feed,
          notify: this.notify,
          state: this.#stack.state,
        });
      }
    } catch (err) {
      report(err);
    } finally {
      await this.#teardown();
    }
  }

  /**
   * @param {any} [error] when the query is ending BECAUSE something failed.
   *   Delivered to observers that implement `error`, which matters most for a
   *   one-shot read: a fetch that threw must not look to its subscriber like an
   *   empty success.  Observers that do not implement it still get `complete`,
   *   so nothing that worked before behaves differently, and `report` still runs
   *   either way so a failure is never simply swallowed.
   *
   *   It is also what the interceptors unwind on: `error` for a query that died
   *   because something failed, `leave` for one that simply ended.  `handled()`
   *   cannot revive a dead query -- by the time it runs the observers have
   *   already been told -- so it means only that the interceptors outside the
   *   one that called it see a query that ended rather than one that broke.
   */
  async #teardown(error) {
    const failed = arguments.length > 0;
    if (this.#dead) {
      return;
    }
    this.#dead = true;

    this.#store._evict(this.#query, this);

    const observers = [...this.observers];
    this.observers.clear();
    for (const observer of observers) {
      try {
        if (failed && observer.error) {
          observer.error(error);
        } else {
          observer.complete?.();
        }
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

    // Last, after the query has let go of everything, the way `leave` runs
    // after an action's lease is released.  Teardown is where every ending
    // meets -- killed, completed after a one-shot fetch, or dead because boot
    // threw -- and it runs once, so this is the query's only unwind.
    if (!this.#stack.empty) {
      const failure = await this.#stack.unwind(error);
      // What brought the query down has already been reported by whoever caught
      // it; what an unwinding hook threw on top of it has not.
      if (failure && failure !== error) {
        report(failure);
      }
    }
  }
}

// Realizes queries and keeps one live controller per query instance.
export class QueryStore {
  #container;
  #dispatcher;
  #interceptors;
  #controllers;
  #dedupKeys = new Map();
  #controllerKeys = new WeakMap();
  #cells = new WeakMap();
  #disposed = false;

  constructor({ container, dispatcher, interceptors, createControllerMap } = {}) {
    this.#container = container ?? new Container();
    this.#dispatcher = dispatcher ?? null;
    // Copied here rather than per query, same as the dispatcher: the list is
    // fixed at construction, and mutating it afterwards has no effect.
    this.#interceptors = interceptors ? [...interceptors] : [];
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

  get _interceptors() {
    return this.#interceptors;
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
    const record = this.#controllerKeys.get(controller);
    if (!record || this.#controllers.get(record.registryKey) !== controller) {
      return;
    }
    this.#controllers.delete(record.registryKey);
    this.#controllerKeys.delete(controller);
    if (record.keys) {
      record.bucket.splice(record.bucket.indexOf(record), 1);
      if (record.bucket.length === 0) {
        record.keys.delete(record.key);
      }
      if (record.keys.size === 0) {
        this.#dedupKeys.delete(queryInstance.constructor);
      }
    }
  }

  // Equality defines sharing; an optional key narrows the comparison bucket.
  // A key alone opts into Map equality. The first active instance supplies
  // the implementation and dependencies, including its equality comparator.
  #registryKey(queryInstance, create = false) {
    const compares = typeof queryInstance.dedupEquiv === 'function';
    const keyed = typeof queryInstance.dedupKey === 'function';
    if (!compares && !keyed) {
      return { registryKey: queryInstance };
    }
    const type = queryInstance.constructor;
    const key = keyed ? queryInstance.dedupKey() : undefined;
    let keys = this.#dedupKeys.get(type);
    let bucket = keys?.get(key);
    const match = bucket?.find((record) => {
      if (record.query === queryInstance) {
        return true;
      }
      if (typeof record.query.dedupEquiv === 'function') {
        return record.query.dedupEquiv(queryInstance);
      }
      return compares ? queryInstance.dedupEquiv(record.query) : true;
    });
    if (match || !create) {
      return match ?? {};
    }
    if (!keys) {
      keys = new Map();
      this.#dedupKeys.set(type, keys);
    }
    if (!bucket) {
      bucket = [];
      keys.set(key, bucket);
    }
    const record = { registryKey: {}, query: queryInstance, keys, bucket, key };
    bucket.push(record);
    return record;
  }

  #controller(queryInstance) {
    const { registryKey } = this.#registryKey(queryInstance);
    return registryKey === undefined ? undefined : this.#controllers.get(registryKey);
  }

  #queryDeps(queryInstance) {
    return [queryInstance.constructor.deps, queryInstance.deps];
  }

  // Realizes a query as a Cell: onDirty() connects, getValue() reads synchronously.
  // subscribe()/peek() remain available as deprecated compatibility methods.
  query(queryInstance) {
    if (!(queryInstance instanceof Query)) {
      throw new TypeError('query() requires an instance of Query');
    }

    const existing = this.#cells.get(queryInstance);
    if (existing) return existing;

    const handle = {
      /** @deprecated Use onDirty(), hasValue(), and getValue() instead. */
      subscribe: (observerOrNext) => {
        if (this.#disposed) {
          throw new Error('The query store has been disposed');
        }

        const observer =
          typeof observerOrNext === 'function'
            ? { next: observerOrNext }
            : observerOrNext || {};

        let controller = this.#controller(queryInstance);
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
          const record = this.#registryKey(queryInstance, true);
          this.#controllerKeys.set(controller, record);
          this.#controllers.set(record.registryKey, controller);
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

            // No complete() for the unsubscriber: withdrawing is not the query
            // ending.  complete() stays reserved for a query dying underneath
            // observers that are still attached (see #teardown).
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

      // Resolves with the active query's current value, waiting for its first
      // one if it has not emitted yet.  If the query is not active -- or dies
      // before emitting -- falls through to the query's fetch().
      //
      // A live query that never emits therefore leaves this pending until it
      // is killed.  That is deliberate: peek() on an active query answers from
      // that query, and a query with subscribers is expected to produce a
      // value.  Callers that cannot block should race it themselves.
      /** @deprecated Async fetch/current-value compatibility API. */
      peek: async () => {
        const controller = this.#controller(queryInstance);
        if (controller && (await controller.received)) {
          return controller.currentValue;
        }

        if (typeof queryInstance.fetch !== 'function') {
          throw new TypeError(
            `${queryInstance.constructor.name} is not active and does not implement fetch()`
          );
        }

        // A peek that fetches is a use of the query in its own right, so it is
        // wrapped like one: enter, fetch, leave -- the shape a dispatch has.
        // The value comes back untouched; interceptors wrap the work, they have
        // no say in its result.
        const stack = new InterceptorStack({
          container: this.#container,
          interceptors: this.#interceptors,
          context: () => ({
            query: queryInstance,
            engineFeed: this.#container.feed,
            bootFeed: controller?.bootFeed,
            killFeed: controller?.killFeed,
          }),
        });

        return await stack.run(async (state) => {
          const lease = await this.#container.lease(...this.#queryDeps(queryInstance));
          try {
            return await queryInstance.fetch(lease.resources, {
              engineFeed: this.#container.feed,
              bootFeed: controller?.bootFeed,
              killFeed: controller?.killFeed,
              state,
            });
          } finally {
            await lease.release();
          }
        });
      },
    };
    const cell = asCell(
      handle,
      () => this.#controller(queryInstance),
      () => {
        if (this.#disposed) throw new Error('The query store has been disposed');
      }
    );
    this.#cells.set(queryInstance, cell);
    return cell;
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
