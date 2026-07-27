// Layer 1: dependency injection.
//
// This module is self contained: it knows nothing about actions or queries.
// Import it on its own if all you want is providers and a container.

import { report } from './internal.js';

const DISPOSED = 'The provider has been disposed';

// Obtains the resources behind a provider's own injected dependencies, runs
// `fn` with them, and releases them again.  The built-in factories use this so
// that their `create`/`destroy`/`dispose` callbacks are handed *resources*,
// the same way actions and queries are, rather than raw providers.
async function withDepResources(depProviders, fn) {
  const resources = {};
  const held = [];

  try {
    for (const [name, provider] of Object.entries(depProviders ?? {})) {
      resources[name] = await provider.obtain();
      held.push([name, provider]);
    }
    return await fn(resources);
  } finally {
    for (const [name, provider] of held) {
      try {
        await provider.release(resources[name]);
      } catch (err) {
        report(err);
      }
    }
  }
}

// The base class for all providers, which manage external resources.
export class Provider {
  static deps = [];

  async obtain(options = {}) {
    throw new Error('obtain() not implemented');
  }

  release(resource, options = {}) {}

  async flush() {}

  // Creates a provider that manages a single shared resource (singleton).
  static fromSingleton(resource, { dispose, deps = [] } = {}) {
    return class SingletonProvider extends Provider {
      static deps = deps;

      #deps;
      #disposed = false;

      constructor(injectedDeps = {}) {
        super();
        this.#deps = injectedDeps;
      }

      async obtain() {
        return resource;
      }

      release() {
        // Nothing to do for a singleton.
      }

      async dispose() {
        if (this.#disposed) {
          return;
        }
        this.#disposed = true;

        if (typeof dispose === 'function') {
          await withDepResources(this.#deps, (deps) => dispose(resource, deps));
        }
      }
    };
  }

  // Creates a provider that manages a pool of at most `size` resources.
  //
  // Every `obtain` joins a FIFO queue which is drained against the available
  // resources and the unused slots, so concurrent obtains can never overshoot
  // `size`, and a failed `create` hands the failure to the caller that is
  // actually waiting on it instead of deadlocking the queue.
  static fromPool(create, destroy, { size = 1, deps = [] } = {}) {
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError('fromPool() requires an integer size of at least 1');
    }

    return class PoolProvider extends Provider {
      static deps = deps;

      #deps;
      #available = [];
      #inUse = new Set();
      #waiting = [];
      #slots = 0;
      #disposed = false;

      constructor(injectedDeps = {}) {
        super();
        this.#deps = injectedDeps;
      }

      async #destroySafely(resource) {
        try {
          await withDepResources(this.#deps, (deps) => destroy(resource, deps));
        } catch (err) {
          report(err);
        }
      }

      // Hands resources to waiters, creating new ones while slots remain.
      #pump() {
        while (this.#waiting.length > 0) {
          if (this.#available.length > 0) {
            const resource = this.#available.shift();
            this.#inUse.add(resource);
            this.#waiting.shift().resolve(resource);
            continue;
          }

          if (this.#slots >= size) {
            return;
          }

          const waiter = this.#waiting.shift();
          this.#slots++;
          // The slot is reserved before awaiting, so a concurrent obtain sees
          // it as taken and the pool never exceeds `size`.
          withDepResources(this.#deps, (deps) => create(deps))
            .then(
              (resource) => {
                if (this.#disposed) {
                  this.#slots--;
                  this.#destroySafely(resource);
                  waiter.reject(new Error(DISPOSED));
                  return;
                }
                this.#inUse.add(resource);
                waiter.resolve(resource);
              },
              (err) => {
                this.#slots--;
                waiter.reject(err);
                this.#pump();
              }
            );
        }
      }

      async obtain() {
        if (this.#disposed) {
          throw new Error(DISPOSED);
        }

        const waiter = Promise.withResolvers();
        this.#waiting.push(waiter);
        this.#pump();
        return await waiter.promise;
      }

      release(resource) {
        if (!this.#inUse.delete(resource)) {
          return;
        }

        if (this.#disposed) {
          this.#slots--;
          this.#destroySafely(resource);
          return;
        }

        this.#available.push(resource);
        this.#pump();
      }

      async dispose() {
        if (this.#disposed) {
          return;
        }
        this.#disposed = true;

        const waiting = this.#waiting.splice(0);
        for (const { reject } of waiting) {
          reject(new Error(DISPOSED));
        }

        const available = this.#available.splice(0);
        this.#slots -= available.length;
        // Resources still checked out are destroyed as they come back in.
        await Promise.all(available.map((resource) => this.#destroySafely(resource)));
      }
    };
  }

  // Creates a provider for a single shared resource that is lazily created and
  // ref-counted, and destroyed when the count drops to zero.
  static fromRefCounted(create, destroy, { deps = [] } = {}) {
    return class RefCountedProvider extends Provider {
      static deps = deps;

      #deps;
      #refCount = 0;
      #creation = null;
      #resource = null;
      #teardown = null;
      #disposed = false;

      constructor(injectedDeps = {}) {
        super();
        this.#deps = injectedDeps;
      }

      async obtain() {
        if (this.#disposed) {
          throw new Error(DISPOSED);
        }

        this.#refCount++;

        // A previous resource may still be tearing down.  Let it finish so we
        // never hold a half-destroyed resource.
        while (this.#teardown) {
          await this.#teardown;
        }

        if (this.#disposed) {
          this.#refCount--;
          throw new Error(DISPOSED);
        }

        if (!this.#creation) {
          this.#creation = withDepResources(this.#deps, (deps) => create(deps));
        }

        try {
          this.#resource = await this.#creation;
          return this.#resource;
        } catch (err) {
          // A failed creation must not poison every later obtain.
          this.#refCount--;
          if (this.#refCount <= 0) {
            this.#refCount = 0;
            this.#creation = null;
            this.#resource = null;
          }
          throw err;
        }
      }

      async release() {
        if (this.#refCount <= 0) {
          return;
        }

        this.#refCount--;
        if (this.#refCount > 0) {
          return;
        }

        const resource = this.#resource;
        const creation = this.#creation;
        this.#resource = null;
        this.#creation = null;

        if (!creation) {
          return;
        }

        this.#teardown = (async () => {
          try {
            // Creation may still be in flight; destroy what it produces.
            const created = resource ?? (await creation.catch(() => null));
            if (created != null) {
              await withDepResources(this.#deps, (deps) => destroy(created, deps));
            }
          } catch (err) {
            report(err);
          } finally {
            this.#teardown = null;
          }
        })();

        await this.#teardown;
      }

      async dispose() {
        this.#disposed = true;

        if (this.#refCount > 0) {
          this.#refCount = 1;
          await this.release();
        }

        while (this.#teardown) {
          await this.#teardown;
        }
      }
    };
  }
}

// A resolved dependency set held for the duration of some work.  Leases are the
// single seam between this layer and the ones above it: actions take a lease
// for one dispatch, queries hold one from boot until kill.
class Lease {
  #entries;
  #released = false;

  constructor(resources, entries) {
    this.resources = resources;
    this.#entries = entries;
  }

  get released() {
    return this.#released;
  }

  // Idempotent: releasing twice never double-releases a resource.
  async release() {
    if (this.#released) {
      return;
    }
    this.#released = true;

    for (const { name, provider, options } of this.#entries) {
      try {
        await provider.release(this.resources[name], options);
      } catch (err) {
        report(err);
      }
    }
    this.#entries = [];
  }
}

// Instantiates and owns a graph of providers, and hands out their resources.
//
// Consumers above this layer only ever need `feed`, `resolve`, `lease` and
// `use`, so anything implementing those four can stand in for a Container.
export class Container {
  #providers = new Map();
  #resolutions = new WeakMap();
  #feed;
  #disposed = false;

  constructor({ providers, feed } = {}) {
    this.#feed = feed ?? new EventTarget();

    if (!providers) {
      return;
    }

    // Memoized so a provider named by two dependents is built exactly once,
    // and so a diamond-shaped graph is walked in linear time.
    const build = (name, path) => {
      if (this.#providers.has(name)) {
        return this.#providers.get(name);
      }

      const ProviderClass = providers[name];
      if (!ProviderClass) {
        throw new Error(`Dependency not found: ${name}`);
      }

      const nextPath = [...path, name];
      if (path.includes(name)) {
        throw new Error(`Cyclic dependency detected: ${nextPath.join(' -> ')}`);
      }

      const resolvedDeps = {};
      for (const depName of ProviderClass.deps ?? []) {
        resolvedDeps[depName] = build(depName, nextPath);
      }

      const provider = new ProviderClass(resolvedDeps, {
        engineFeed: this.#feed,
        container: this,
      });
      this.#providers.set(name, provider);
      return provider;
    };

    for (const name of Object.keys(providers)) {
      build(name, []);
    }
  }

  // The shared event bus.  Providers, actions and queries all see this one.
  get feed() {
    return this.#feed;
  }

  get disposed() {
    return this.#disposed;
  }

  has(name) {
    return this.#providers.has(name);
  }

  get(name) {
    const provider = this.#providers.get(name);
    if (!provider) {
      throw new Error(`Dependency not found: ${name}`);
    }
    return provider;
  }

  // Turns a deps declaration -- either `['a', 'b']` or `{ a: options }` -- into
  // a map of `{ provider, options }`.  Results are memoized against the
  // declaration object, so declarations must not be mutated after first use.
  resolve(depsConfig) {
    if (!depsConfig) {
      return {};
    }

    const cached = this.#resolutions.get(depsConfig);
    if (cached) {
      return cached;
    }

    const resolved = {};
    if (Array.isArray(depsConfig)) {
      for (const name of depsConfig) {
        resolved[name] = { provider: this.get(name), options: undefined };
      }
    } else {
      for (const name of Object.keys(depsConfig)) {
        resolved[name] = { provider: this.get(name), options: depsConfig[name] };
      }
    }

    this.#resolutions.set(depsConfig, resolved);
    return resolved;
  }

  // Merges several declarations; later ones win.
  resolveAll(...depsConfigs) {
    const present = depsConfigs.filter(Boolean);
    if (present.length === 1) {
      return this.resolve(present[0]);
    }
    return Object.assign({}, ...present.map((config) => this.resolve(config)));
  }

  // Obtains every declared resource, or none of them: if one `obtain` fails,
  // the ones already obtained are released before the error propagates.
  async lease(...depsConfigs) {
    if (this.#disposed) {
      throw new Error('The container has been disposed');
    }

    const deps = this.resolveAll(...depsConfigs);
    const resources = {};
    const entries = [];

    try {
      for (const [name, { provider, options }] of Object.entries(deps)) {
        resources[name] = await provider.obtain(options);
        entries.push({ name, provider, options });
      }
    } catch (err) {
      await new Lease(resources, entries).release();
      throw err;
    }

    return new Lease(resources, entries);
  }

  // Scoped lease: obtain, run, release -- even if `fn` throws.
  async use(depsConfig, fn) {
    const lease = await this.lease(depsConfig);
    try {
      return await fn(lease.resources);
    } finally {
      await lease.release();
    }
  }

  // Flushes then disposes every provider.  Idempotent.
  async dispose() {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;

    // Providers are built dependencies-first, so tearing down in reverse
    // insertion order means a provider is always disposed before anything it
    // depends on -- its flush/dispose can still use its dependencies.
    const teardownOrder = [...this.#providers.values()].reverse();

    for (const provider of teardownOrder) {
      try {
        await provider.flush?.();
      } catch (err) {
        report(err);
      }
    }

    for (const provider of teardownOrder) {
      try {
        await provider.dispose?.();
      } catch (err) {
        report(err);
      }
    }
  }
}
