export class Engine {
  static #resolvedDepsCache = Symbol('resolvedDepsCache');

  #providers;
  #interceptors;
  #engineFeed;
  #queryControllers;

  constructor({ providers, interceptors, hooks }) {
    this.#providers = new Map();
    this.#interceptors = interceptors || [];
    this.#engineFeed = new EventTarget();
    this.#queryControllers = hooks?.createQueryControllersMap?.() ?? new Map();

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
      for (const depName of ProviderClass.deps) {
        resolvedDeps[depName] = resolveProvider(depName, nextPath);
      }

      const provider = new ProviderClass(resolvedDeps);
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

    for (const name of Object.keys(depsConfig)) {
      const provider = this.#providers.get(name);
      if (!provider) {
        throw new Error(`Dependency not found: ${name}`);
      }

      const options = Array.isArray(depsConfig) ? {} : depsConfig[name];
      resolvedDeps[name] = { provider, options };
    }
    return resolvedDeps;
  }

  /**
   * Dispatches an action, managing the resource lifecycle.
   * This method is non-blocking and returns an EventTarget immediately.
   * @param {Action} actionInstance
   * @returns {EventTarget} The dispatch feed for this specific action.
   */
  dispatch(actionInstance) {
    if (!(actionInstance instanceof Action)) {
      throw new TypeError('dispatch() requires an instance of Action.');
    }

    const dispatchFeed = new EventTarget();
    
    (async () => {
      const enteredInterceptors = [];
      let state = {};
      let error = null;
  
      try {
        // Phase 1: Run 'enter' interceptors. Build the stack of entered interceptors.
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
                engineFeed: this.#engineFeed, 
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
  
        // Phase 2: Obtain and execute the main action, releasing resources immediately after.
        try {
          const actionDeps = this.#resolveDeps(actionInstance.constructor.deps, actionInstance.constructor);
          const resources = {};
          for (const [name, { provider, options }] of Object.entries(actionDeps)) {
            resources[name] = await provider.obtain(options);
          }
          await actionInstance.execute(resources, {
            dispatchFeed,
            engineFeed: this.#engineFeed,
            state
          });
        } finally {
          // Since actionDeps and resources are scoped to this block, we need to re-resolve
          // the deps to ensure cleanup even if a resource fails to be obtained.
          const actionDeps = this.#resolveDeps(actionInstance.constructor.deps, actionInstance.constructor);
          const resources = {};
          for (const [name, { provider, options }] of Object.entries(actionDeps)) {
            // This check is important to prevent attempting to release a non-obtained resource.
            if (Object.prototype.hasOwnProperty.call(resources, name)) {
              provider.release(resources[name], options);
            }
          }
        }
      } catch (e) {
        error = e;
      } finally {
        // Phase 3: Unwind the stack.
        // Run leave/error hooks in reverse order of entry.
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
                  engineFeed: this.#engineFeed, 
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
            // If a leave/error hook fails, we re-capture the error and ensure it is propagated.
            error = e;
          }
        }
        
        // Phase 4: If an error was never handled, dispatch an event.
        if (error) {
          dispatchFeed.dispatchEvent(new ErrorEvent('error', { error: error, message: error.message }));
        } else {
          dispatchFeed.dispatchEvent(new Event('complete'));
        }
      }
    })();
    
    return dispatchFeed;
  }

  #createQueryController(queryInstance) {
    const queryDeps = this.#resolveDeps(queryInstance.constructor.deps, queryInstance.constructor);
    const engineFeed = this.#engineFeed;
    const engine = this;

    return {
      resources: {},
      observers: new Set(),

      notify(nextValue) {
        this.currentValue = nextValue;

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

          queryInstance.boot(
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
            await queryInstance.kill(
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
        } catch (err) {
          console.error(err);
        } finally {
          for (const [name, { provider, options }] of Object.entries(queryDeps)) {
            provider.release(this.resources[name], options);
            delete this.resources[name];
          }
        }
      }
    };
  }

  /**
   * Executes a query, managing the resource lifecycle for the duration of the subscription.
   * @param {Query} queryInstance
   * @returns {object} An object with subscribe method (Observable stub).
   */
  query(queryInstance) {
    if (!(queryInstance instanceof Query)) {
      throw new TypeError('query() requires an instance of Query.');
    }

    return {
      subscribe: observer => {
        let controller = this.#queryControllers.get(queryInstance);
        if (controller) {
          controller.observers.add(observer);
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
        if (controller) {
          return controller.currentValue;
        }

        const resources = {};
        try {
          for (const [name, { provider, options }] of Object.entries(queryDeps)) {
            resources[name] = await provider.obtain(options);
          }

          return await queryInstance.fetch(
            resources,
            {
              engineFeed: this.#engineFeed,
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
        await provider.dispose?.();
      } catch (err) {
        console.log(err);
      }
    }
  }
}

/**
 * The base class for all providers, which manage external resources.
 */
export class Provider {
  #deps;
  constructor(deps) {
    this.#deps = deps;
  }
  static deps = [];
  async obtain(options = {}) { throw new Error('obtain() not implemented'); }
  release(resource, options = {}) { throw new Error('release() not implemented'); }

  /**
   * Creates a provider that manages a single shared resource (singleton).
   * @param {any} resource The single, shared resource.
   * @returns {Provider} A new Provider instance.
   */
  static fromSingleton(resource) {
    return new class extends Provider {
      async obtain() {
        return resource;
      }
      release() {
        // Nothing to do for a singleton
      }
    }();
  }

  /**
   * Creates a provider that manages a pool of static resources.
   * @param {function(): any} create A function that creates a new resource.
   * @param {function(any): void} destroy A function to destroy a resource.
   * @param {object} [options]
   * @param {number} [options.size=10] The maximum size of the resource pool.
   * @returns {Provider} A new Provider instance.
   */
  static fromPool(create, destroy, size) {
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
    
    const releaseResource = (resource) => {
      if (inUse.has(resource)) {
        if (disposed) {
          try {
            destroy(resource);
          } catch(err) {
            console.error(err);
          }
        } if (waiting.length > 0) {
          const resolve = waiting.shift().resolve;
          resolve(resource);
        } else {
          inUse.delete(resource);
          available.push(resource);
        }
      }
    };

    return new class extends Provider {
      async obtain() {
        return await getResource();
      }
      release(resource) {
        releaseResource(resource);
      }
      dispose() {
        disposed = true;

        for (const { reject } of waiting) {
          reject(new Error(disposedErrorText));
        }
        waiting.length = 0;

        for (const resource of available) {
          try {
            destroy(resource);
          } catch(err) {
            console.error(err);
          }
        }
        available.length = 0;
      }
    }();
  }

  /**
   * Creates a provider for a single shared resource that is lazily created and
   * ref-counted, and destroyed when the count drops to zero.
   * @param {function(): Promise<any>} create An async function to create the resource.
   * @param {function(any): Promise<void>} destroy An async function to destroy the resource.
   * @returns {Provider} A new Provider instance.
   */
  static fromRefCounted(create, destroy) {
    let refCount = 0;
    let resource = null;
    let creationPromise = null;
    let isDestroying = false;

    const obtain = async () => {
      refCount++;
      if (refCount === 1) {
        isDestroying = false;
        creationPromise = create();
        resource = await creationPromise;
      } else if (creationPromise) {
        // A creation is in progress, so wait for it to complete.
        await creationPromise;
      }
      return resource;
    };

    const release = async () => {
      refCount--;
      if (refCount <= 0 && resource && !isDestroying) {
        isDestroying = true;
        try {
          await destroy(resource);
        } finally {
          resource = null;
          refCount = 0;
          creationPromise = null;
          isDestroying = false;
        }
      }
    };

    return new class extends Provider {
      async obtain() {
        return await obtain();
      }
      release() {
        release();
      }
    }();
  }
}

/**
 * The base class for all actions, which perform data mutations.
 */
export class Action {
  static deps = {};
  async execute(deps, feeds) { throw new Error('execute() not implemented'); }
}

/**
 * The base class for all queries, which fetch and watch data.
 */
export class Query {
  static deps = {};
  async boot(deps, feeds) { throw new Error('boot() not implemented'); }
  async kill(deps, feeds) { throw new Error('kill() not implemented'); }
  async peek(deps, feeds) { throw new Error('peek() not implemented'); }
}
