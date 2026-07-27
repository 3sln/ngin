# ngin

> [!WARNING]
> This is a work-in-progress project and is not yet ready for production use.

`ngin` is a lightweight and flexible state management library designed to help
you organize your frontend application logic. It uses a dependency injection
model to coordinate resources, actions, and queries, keeping your code clean
and testable.

It is built as three independent layers, so you can take only what you need:

| Layer | Import | Exports | Depends on |
| --- | --- | --- | --- |
| Dependency injection | `@3sln/ngin/providers` | `Provider`, `Container` | — |
| Actions | `@3sln/ngin/actions` | `Action`, `Dispatcher` | providers |
| Queries | `@3sln/ngin/queries` | `Query`, `QueryStore` | providers |
| Everything | `@3sln/ngin` | all of the above, plus `Engine` | — |

Actions and queries are siblings: neither imports the other. See
[Layered Usage](#layered-usage).

## Quick Start

```javascript
import { Engine, Action, Query, Provider } from 'ngin';

// Set up a LoggerProvider. It's a dependency for other stuff.
class LoggerProvider extends Provider {
  obtain() {
    // This is the actual resource.
    return {
      log: (message) => console.log(`[LOG]: ${message}`)
    };
  }
  release() {}
}

// Next, a DataProvider that needs the logger. Providers get other providers
// injected, so they can handle their dependencies' lifecycles.
class DataProvider extends Provider {
  static deps = ['logger'];
  
  constructor({ logger }) {
    super();
    this.loggerProvider = logger;
  }
  
  async obtain() {
    const logger = await this.loggerProvider.obtain();
    logger.log('Data connection created.');
    this.loggerProvider.release(logger);
    // The resource is an object with a fetchData method.
    return {
      fetchData: () => 'some data'
    };
  }
  
  async release() {
    const logger = await this.loggerProvider.obtain();
    logger.log('Data connection destroyed.');
    this.loggerProvider.release(logger);
  }
}

// An interceptor that uses the logger. Interceptors, actions, and queries
// all get the actual resource injected.
const loggerInterceptor = {
  deps: ['logger'],
  enter: ({ logger }, { action }) => {
    logger.log(`Entering action: ${action.constructor.name}`);
  },
  leave: ({ logger }, { action }) => {
    logger.log(`Leaving action: ${action.constructor.name}`);
  },
};

// An Action that depends on the Data Provider.
class MyAction extends Action {
  static deps = ['data'];
  async execute({ data }) {
    console.log(`Executing action with: ${data.fetchData()}`);
  }
}

// A Query that also depends on the Data Provider.
class MyQuery extends Query {
  static deps = ['data'];
  // Queries are booted on the first subscriber.
  async boot({ data }, { notify }) {
    notify(data.fetchData());
  }
  // Queries are killed when the last subscriber unsubscribes.
  async kill({ data }) {
    console.log(`Query killed with data: ${data.fetchData()}`);
  }
}

// Instantiate the engine and kick off the examples.
const engine = new Engine({
  providers: {
    logger: LoggerProvider,
    data: DataProvider,
  },
  interceptors: [loggerInterceptor],
});

console.log('--- Dispatching Action ---');
const actionFeed = engine.dispatch(new MyAction());
await new Promise(resolve => actionFeed.addEventListener('complete', resolve, { once: true }));

console.log('--- Query Lifecycle ---');
// The result of Engine#query is a minimal RxJS-style observable.
// It also has a 'peek' method to get the current value, which will use the
// last observed value if the query is active, otherwise it will call
// the query's 'fetch' method.
const queryHandle = engine.query(new MyQuery());
const subscription = queryHandle.subscribe({
  next: (value) => console.log(`Query received value: ${value}`),
});

setTimeout(() => {
  console.log('Unsubscribing from query...');
  subscription.unsubscribe();
}, 100);

await engine.dispose();
```

-----

## Layered Usage

`Engine` is a facade. It builds a `Container`, a `Dispatcher` and a
`QueryStore` and wires them together — nothing more. When you only need part of
that, build the part you need.

### Just dependency injection

```javascript
import { Container, Provider } from '@3sln/ngin/providers';

const container = new Container({
  providers: {
    config: Provider.fromSingleton({ apiUrl: 'https://api.example.com' }),
    api: Provider.fromRefCounted(
      async ({ config }) => {
        const cfg = await config.obtain();
        try {
          return new ApiClient(cfg.apiUrl);
        } finally {
          config.release(cfg);
        }
      },
      (api) => api.close(),
      { deps: ['config'] }
    ),
  },
});

// Scoped: obtain, run, release — even if the callback throws.
const users = await container.use(['api'], ({ api }) => api.getUsers());

// Or hold a lease for work that outlives a single call.
const lease = await container.lease(['api']);
lease.resources.api.subscribe(/* ... */);
await lease.release();

await container.dispose();
```

### Dependency injection plus actions

```javascript
import { Container } from '@3sln/ngin/providers';
import { Action, Dispatcher } from '@3sln/ngin/actions';

const dispatcher = new Dispatcher({
  container: new Container({ providers }),
  interceptors: [loggerInterceptor],
});

dispatcher.dispatch(new MyAction());
```

### Dependency injection plus queries

```javascript
import { Container } from '@3sln/ngin/providers';
import { QueryStore } from '@3sln/ngin/queries';

const queries = new QueryStore({ container: new Container({ providers }) });

queries.query(new MyQuery()).subscribe(console.log);
```

A `QueryStore` built without a `dispatcher` works fine; it only needs one if a
query you realize declares a `bootAction` or `killAction`.

### Composing them yourself

`Engine` accepts pre-built layers, which is how you share a container between
engines or substitute a stub in tests. It also hands them back:

```javascript
const container = new Container({ providers });
const engine = new Engine({ container, interceptors });

engine.container;   // the Container above
engine.dispatcher;  // Dispatcher
engine.queries;     // QueryStore
```

### The seam

Everything above the provider layer talks to it through four members and
nothing else — `feed`, `resolve(depsConfig)`, `lease(...depsConfigs)` and
`use(depsConfig, fn)` — so anything implementing those can stand in for a
`Container`.

A **lease** is what lets the two upper layers share one resource model despite
very different lifetimes: an action holds a lease for a single dispatch, a
query holds one from `boot` until `kill`. `lease()` obtains every declared
resource or none of them, and its `release()` is idempotent.

-----

## Provider Options
You can configure dependencies for actions, interceptors, or queries with an
options object. This object is passed as the first argument to the provider's
`obtain` method.

For these components, you can specify dependencies using an object instead of
an array. The values of this object are the options passed to the corresponding
provider.

```javascript
class MyProviderWithOptions extends Provider {
  obtain(options) {
    // options will be { timeout: 5000 }
    return { timeout: options.timeout };
  }
}

// In an action, you can declare a dependency with options.
class MyActionWithOptions extends Action {
  static deps = {
    myProvider: { timeout: 5000 }
  };
  async execute({ myProvider }) {
    console.log(`Provider configured with timeout: ${myProvider.timeout}`);
  }
}

const engine = new Engine({
  providers: {
    myProvider: MyProviderWithOptions,
  }
});

engine.dispatch(new MyActionWithOptions());
```

-----

## Provider Lifecycle: `obtain`, `release`, `flush`, and `dispose`
Providers manage the lifecycle of the resources they provide.

- **`obtain(options)`**: This method is called whenever a consumer (like an Action or Query) needs a resource. It's responsible for creating or acquiring the resource. It can optionally receive an `options` object from the consumer.

- **`release(resource, options)`**: This is the counterpart to `obtain`. It's called after the consumer has finished its work. For providers that manage a pool of resources, this is where you would return the `resource` to the pool. For singleton-like providers, this method is often a no-op.

- **`flush()`**: This optional method is called on all providers when the `engine.dispose()` method is invoked, just before the `dispose` methods are called. This is the ideal place to perform any finalization that needs to happen before resources are permanently cleaned up, especially if that finalization requires using other providers.

- **`dispose()`**: This optional method is called on all providers when the `engine.dispose()` method is invoked. It is the correct place to perform permanent cleanup of a provider's underlying resources, such as closing database connections, terminating web sockets, or completing observable streams.

-----

## Built-in Provider Implementations
`ngin` offers three built-in provider types for resource management.

### Singleton Provider
Perfect for resources that are globally shared.

```javascript
const mySingletonProvider = Provider.fromSingleton({ database: 'my-db-instance' });
```

### Pool Provider
Ideal for managing a fixed number of resources, like a pool of database
connections.

```javascript
const createConnection = async () => new DatabaseConnection();
const destroyConnection = (conn) => conn.close();
const myPoolProvider = Provider.fromPool(createConnection, destroyConnection, {size: 10});
```

### Reference-Counted Provider
Use this for resources that are lazily created and destroyed only when no
longer in use.

```javascript
const createResource = async () => new ExpensiveResource();
const destroyResource = (res) => res.cleanup();
const myRefCountedProvider = Provider.fromRefCounted(createResource, destroyResource);
```

### Dependencies in the built-ins

All three factories take a `deps` option. Those dependencies arrive at
`create`, `destroy` and `dispose` as **providers** — the same thing a provider
written by hand receives in its constructor — so the resource you build can
hold a dependency for its own lifetime:

```javascript
const ConnectionProvider = Provider.fromPool(
  async ({ credentials }) => {
    // Obtained in create, held by the connection, released in destroy.
    const creds = await credentials.obtain();
    return { conn: await connect(creds), credentials, creds };
  },
  async ({ conn, credentials, creds }) => {
    await conn.close();
    credentials.release(creds);
  },
  { size: 10, deps: ['credentials'] }
);
```

If a dependency is only read at creation time, obtain and release it around
that read:

```javascript
const WorkerProvider = Provider.fromPool(
  async ({ config }) => {
    const cfg = await config.obtain();
    try {
      return new Worker(cfg.workerPath);   // only the path is retained
    } finally {
      config.release(cfg);
    }
  },
  (worker) => worker.terminate(),
  { size: 4, deps: ['config'] }
);
```

Actions, queries and interceptors are the other way around: they are consumers
rather than resource managers, so they receive already-obtained **resources**,
released for them when their work finishes.
