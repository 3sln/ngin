export class Engine {
  static #resolvedDepsCache = Symbol('resolvedDepsCache');

  #providers;
  #interceptors;
  #queryControllers;

  constructor({ providers, interceptors, hooks }) {
    this.#providers = new Map();
    this.#interceptors = interceptors || [];
    this.#queryControllers = hooks?.createQueryControllersMap?.() ?? new Map();
    this.feed = new EventTarget();

    if (!providers) {
      return;
    }

    const resolveProvider = (name, depsPath) => {
      const ProviderClass = providers[name];
      if (!ProviderClass) {
        throw new Error(`Dependency not found: ${name}`);
      }

      const nextPath = [...depsPath, name];
      if (depsPath?.includes(name)) {
        throw new Error(`Cyclic dependency detected: ${nextPath.join(' -> ')}`);
      }

      const resolvedDeps = {};
      for (const depName of ProviderClass.deps ?? []) {
        resolvedDeps[depName] = resolveProvider(depName, nextPath);
      }

      const provider = new ProviderClass(resolvedDeps, {engineFeed: this.feed});
      this.#providers.set(name, provider);
      return provider;
    };

    for (const name of Object.keys(providers)) {
      resolveProvider(name, []);
    }
  }

  #resolveDeps(depsConfig, cacheObj) {
    let resolvedDeps = cacheObj?.[Engine.#resolvedDepsCache];
    if (resolvedDeps) {
      return resolvedDeps;
    }

    resolvedDeps = {};
    if (!depsConfig) {
      return resolvedDeps;
    }

    if (Array.isArray(depsConfig)) {
      for (const name of depsConfig) {
        const provider = this.#providers.get(name);
        if (!provider) {
          throw new Error(`Dependency not found: ${name}`);
        }

        resolvedDeps[name] = { provider };
      }
    } else {
      for (const name of Object.keys(depsConfig)) {
        const provider = this.#providers.get(name);
        if (!provider) {
          throw new Error(`Dependency not found: ${name}`);
        }

        resolvedDeps[name] = {
          provider,
          options: depsConfig[name]
        };
      }
    }

    return resolvedDeps;
  }

  // Dispatch an action.
  dispatch(actionInstance) {
    if (!(actionInstance instanceof Action)) {
      throw new TypeError('dispatch() requires an instance of Action');
    }

    const dispatchFeed = new EventTarget();

    setTimeout(async () => {
      const enteredInterceptors = [];
      let state = {};
      let error = null;

      try {
        // Phase 1: Run 'enter' interceptors.
        for (const interceptor of this.#interceptors) {
          enteredInterceptors.push(interceptor);
          if (interceptor.enter) {
            const interceptorDeps = this.#resolveDeps(interceptor.deps, interceptor);
            const interceptorResources = {};
            try {
              for (const [name, { provider, options }] of Object.entries(interceptorDeps)) {
                interceptorResources[name] = await provider.obtain(options);
              }
              const newState = await interceptor.enter(interceptorResources, { 
                dispatchFeed, 
                engineFeed: this.feed, 
                state, 
                action: actionInstance 
              });
              if (newState !== undefined) {
                state = newState;
              }
            } finally {
              for (const [name, { provider, options }] of Object.entries(interceptorDeps)) {
                if (Object.prototype.hasOwnProperty.call(interceptorResources, name)) {
                  provider.release(interceptorResources[name], options);
                }
              }
            }
          }
        }

        // Phase 2: Obtain and execute the main action.
        const staticDeps = this.#resolveDeps(actionInstance.constructor.deps, actionInstance.constructor);
        const instanceDeps = this.#resolveDeps(actionInstance.deps, actionInstance);
        const allDeps = { ...staticDeps, ...instanceDeps };
        
        const resources = {};
        try {
          for (const [name, { provider, options }] of Object.entries(allDeps)) {
            resources[name] = await provider.obtain(options);
          }
          await actionInstance.execute(resources, {
            dispatchFeed,
            engineFeed: this.feed,
            state
          });
        } finally {
          for (const [name, { provider, options }] of Object.entries(allDeps)) {
            if (Object.prototype.hasOwnProperty.call(resources, name)) {
              provider.release(resources[name], options);
            }
          }
        }
      } catch (e) {
        error = e;
      } finally {
        // Phase 3: Unwind the stack.
        for (let i = enteredInterceptors.length - 1; i >= 0; i--) {
          const interceptor = enteredInterceptors[i];
          try {
            if (error && interceptor.error) {
              const interceptorDeps = this.#resolveDeps(interceptor.deps, interceptor);
              const interceptorResources = {};
              try {
                for (const [name, { provider, options }] of Object.entries(interceptorDeps)) {
                  interceptorResources[name] = await provider.obtain(options);
                }
                const errorContext = { 
                  action: actionInstance, 
                  state, 
                  error,
                  handled: () => { error = null; }
                };
                const newState = await interceptor.error(interceptorResources, errorContext);
                if (newState !== undefined) {
                  state = newState;
                }
              } finally {
                for (const [name, { provider, options }] of Object.entries(interceptorDeps)) {
                  if (Object.prototype.hasOwnProperty.call(interceptorResources, name)) {
                    provider.release(interceptorResources[name], options);
                  }
                }
              }
            } else if (!error && interceptor.leave) {
              const interceptorDeps = this.#resolveDeps(interceptor.deps, interceptor);
              const interceptorResources = {};
              try {
                for (const [name, { provider, options }] of Object.entries(interceptorDeps)) {
                  interceptorResources[name] = await provider.obtain(options);
                }
                const newState = await interceptor.leave(interceptorResources, { 
                  dispatchFeed, 
                  engineFeed: this.feed, 
                  state, 
                  action: actionInstance 
                });
                if (newState !== undefined) {
                  state = newState;
                }
              } finally {
                for (const [name, { provider, options }] of Object.entries(interceptorDeps)) {
                  if (Object.prototype.hasOwnProperty.call(interceptorResources, name)) {
                    provider.release(interceptorResources[name], options);
                  }
                }
              }
            }
          } catch (e) {
            error = e;
          }
        }

        if (error) {
          dispatchFeed.dispatchEvent(new ErrorEvent('error', { error: error, message: error.message }));
        } else {
          dispatchFeed.dispatchEvent(new Event('complete'));
        }
      }
    });

    return dispatchFeed;
  }

  #createQueryController(queryInstance) {
    const staticDeps = this.#resolveDeps(queryInstance.constructor.deps, queryInstance.constructor);
    const instanceDeps = this.#resolveDeps(queryInstance.deps, queryInstance);
    const queryDeps = { ...staticDeps, ...instanceDeps };

    const engineFeed = this.feed;
    const engine = this;
    const received = Promise.withResolvers();
    let hadValue = false;

    return {
      resources: {},
      observers: new Set(),
      received: received.promise,

      notify(nextValue) {
        this.currentValue = nextValue;

        if (!hadValue) {
          hadValue = true;
          this.hasValue = true;
          received.resolve(true);
        }

        for (const observer of this.observers) {
          try {
            observer.next?.(nextValue);
          } catch (err) {
            console.error(err);
          }
        }
      },
      async boot() {
        try {
          if (queryInstance.bootAction) {
            this.bootFeed = engine.dispatch(queryInstance.bootAction);
          }
          for (const [name, { provider, options }] of Object.entries(queryDeps)) {
            this.resources[name] = await provider.obtain(options);
          }

          await queryInstance.boot?.(
            this.resources,
            {
              notify: this.notify.bind(this),
              engineFeed: engineFeed,
              bootFeed: this.bootFeed,
            }
          );
        } catch (err) {
          console.error(err);

          for (const [name, { provider, options }] of Object.entries(queryDeps)) {
            if (Object.prototype.hasOwnProperty.call(this.resources, name)) {
              provider.release(this.resources[name], options);
              delete this.resources[name];
            }
          }
        }
      },
      async kill() {
        try {
          if (queryInstance.killAction) {
            this.killFeed = engine.dispatch(queryInstance.killAction);
          }
          if (queryInstance.kill) {
            await queryInstance.kill?.(
              this.resources,
              {
                bootFeed: this.bootFeed,
                killFeed: this.killFeed,
                engineFeed: engineFeed,
                notify: this.notify.bind(this),
              }
            );
          }
          for (const observer of this.observers) {
            if (observer.complete) {
              try {
                observer.complete()
              } catch (err) {
                console.error(err);
              }
            };
          }

          this.observers.clear();

          if (!hadValue) {
            received.resolve(false);
          }
        } catch (err) {
          console.error(err);
        } finally {
          for (const [name, { provider, options }] of Object.entries(queryDeps)) {
            if (Object.prototype.hasOwnProperty.call(this.resources, name)) {
              provider.release(this.resources[name], options);
              delete this.resources[name];
            }
          }
        }
      }
    };
  }

  // Realizes a query.  Call `subscribe` on the returned object
  // to use it as an RxJS style observable, or `peek` to get a
  // look at the current value if the query is active, or fetch
  // it otherwise.
  query(queryInstance) {
    if (!(queryInstance instanceof Query)) {
      throw new TypeError('query() requires an instance of Query');
    }

    return {
      subscribe: (observerOrNext) => {
        const observer = (typeof observerOrNext === 'function')
            ? { next: observerOrNext }
            : (observerOrNext || {});

        let controller = this.#queryControllers.get(queryInstance);
        if (controller) {
          controller.observers.add(observer);
          if (controller.hasValue) {
            observer.next?.(controller.currentValue);
          }
        } else {
          controller = this.#createQueryController(queryInstance);
          this.#queryControllers.set(queryInstance, controller);
          controller.observers.add(observer);
          controller.boot();
        }

        return {
          unsubscribe: () => {
            controller.observers.delete(observer);
            if (controller.observers.size === 0) {
              this.#queryControllers.delete(queryInstance);
              controller.kill();
            }
          }
        }
      },
      peek: async () => {
        const controller = this.#queryControllers.get(queryInstance);
        if (controller && await controller.received) {
          return controller.currentValue;
        }

        const staticDeps = this.#resolveDeps(queryInstance.constructor.deps, queryInstance.constructor);
        const instanceDeps = this.#resolveDeps(queryInstance.deps, queryInstance);
        const queryDeps = { ...staticDeps, ...instanceDeps };

        const resources = {};
        try {
          for (const [name, { provider, options }] of Object.entries(queryDeps)) {
            resources[name] = await provider.obtain(options);
          }

          return await queryInstance.fetch(
            resources,
            {
              engineFeed: this.feed,
              bootFeed: this.bootFeed,
              killFeed: this.killFeed,
            }
          );
        } finally {
          for (const [name, { provider, options }] of Object.entries(queryDeps)) {
            if (Object.prototype.hasOwnProperty.call(resources, name)) {
              provider.release(resources[name], options);
              delete resources[name];
            }
          }
        }
      }
    };
  }

  async dispose() {
    for (const controller of this.#queryControllers.values()) {
      await controller.kill();
    }

    for (const provider of this.#providers.values()) {
      try {
        await provider.flush?.();
      } catch (err) {
        console.log(err);
      }
    }

    for (const provider of this.#providers.values()) {
      try {
        await provider.dispose?.();
      } catch (err) {
        console.log(err);
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

  release(resource, options = {}) {
    throw new Error('release() not implemented');
  }

  async flush() {}

  
  // Creates a provider that manages a single shared resource (singleton).
  static fromSingleton(resource, {dispose} = {}) {
    return class extends Provider {
      async obtain() {
        return resource;
      }

      release() {
        // Nothing to do for a singleton
      }

      async dispose() {
        if (typeof(dispose) === 'function') {
          await dispose(resource);
        }
      }
    };
  }

  // Creates a provider that manages a pool of static resources.
  static fromPool(create, destroy, {size = 1, deps = []} = {}) {
    const available = [];
    const inUse = new Set();
    const waiting = [];
    let disposed = false;
    const disposedErrorText = 'The provider has been disposed';

    const getResource = async () => {
      if (disposed) {
        throw new Error(disposedErrorText);
      } else if (available.length > 0) {
        const resource = available.shift();
        inUse.add(resource);
        return resource;
      } else if (inUse.size < size) {
        const resource = await create();
        inUse.add(resource);
        return resource;
      } else {
        return new Promise(
          (resolve, reject) => waiting.push({ resolve, reject})
        );
      }
    };

    const releaseResource = (resource, deps) => {
      if (inUse.has(resource)) {
        if (disposed) {
          try {
            destroy(resource, deps);
          } catch(err) {
            console.error(err);
          }
          inUse.delete(resource);
        } else if (waiting.length > 0) {
          const resolve = waiting.shift().resolve;
          resolve(resource);
        } else {
          inUse.delete(resource);
          available.push(resource);
        }
      }
    };

    return class extends Provider {
      static deps = deps;
      #deps;

      constructor(deps) {
        super();
        this.#deps = deps;
      }

      async obtain() {
        return await getResource(this.#deps);
      }

      release(resource) {
        releaseResource(resource, this.#deps);
      }

      dispose() {
        disposed = true;

        for (const { reject } of waiting) {
          reject(new Error(disposedErrorText));
        }
        waiting.length = 0;

        for (const resource of available) {
          try {
            destroy(resource, this.#deps);
          } catch(err) {
            console.error(err);
          }
        }
        available.length = 0;
      }
    };
  }

  // Creates a provider for a single shared resource that is lazily created and
  // ref-counted, and destroyed when the count drops to zero.
  static fromRefCounted(create, destroy, {deps = []} = {}) {
    let refCount = 0;
    let resource = null;
    let creationPromise = null;
    let isDestroying = false;

    const obtain = async (deps) => {
      refCount++;
      if (refCount === 1) {
        isDestroying = false;
        creationPromise = create(deps);
        resource = await creationPromise;
      } else if (creationPromise) {
        // A creation is in progress, so wait for it to complete.
          await creationPromise;
      }
      return resource;
    };

    const release = async (deps) => {
      refCount--;
      if (refCount <= 0 && resource && !isDestroying) {
        isDestroying = true;
        try {
          await destroy(resource, deps);
        } finally {
          resource = null;
          refCount = 0;
          creationPromise = null;
          isDestroying = false;
        }
      }
    };

    return class extends Provider {
      static deps = deps;
      #deps;

      constructor(deps) {
        super();
        this.#deps = deps;
      }

      async obtain() {
        return await obtain(this.#deps);
      }
      release() {
        release(this.#deps);
      }
    };
  }
}

export class Action {}
export class Query {}
