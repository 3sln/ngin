# Providers

Providers are responsible for managing the lifecycle of resources. A resource can be anything: a service class, a database connection, a configuration object, or even a simple primitive.

`ngin` provides a base `Provider` class and several static helper methods for common patterns.

This layer stands on its own. If all you want is dependency injection, import
it directly and skip the rest of the library:

```javascript
import { Container, Provider } from '@3sln/ngin/providers';
```

## The `Provider` Class

Custom providers extend the `Provider` class and implement the `obtain` method. They can optionally implement `release`, `flush`, and `dispose`.

```javascript
import { Provider } from '@3sln/ngin';

class MyProvider extends Provider {
  // Declare dependencies
  static deps = ['otherService'];

  constructor({ otherService }) {
    super();
    this.otherService = otherService;
  }

  // Called when a consumer requests the resource
  async obtain(options) {
    const service = await this.otherService.obtain();
    return new MyResource(service, options);
  }

  // Called when the consumer is done
  release(resource, options) {
    resource.cleanup();
    this.otherService.release();
  }
}
```

## Built-in Providers

### Singleton

Use `Provider.fromSingleton` for resources that should be shared across the entire application.

```javascript
import { Provider } from '@3sln/ngin';

const ConfigProvider = Provider.fromSingleton({
  apiUrl: 'https://api.example.com',
  timeout: 5000,
});
```

### Pool

Use `Provider.fromPool` to manage a pool of resources. This is useful for things like database connections or workers. You can also specify dependencies, which are passed to the `create` and `destroy` functions **as providers**, so `create` decides how long each one is held for.

```javascript
import { Provider } from '@3sln/ngin';

const createWorker = async ({ config }) => {
  // `config` is a provider.  The path is all we keep, so obtain and release
  // it around the read.
  const cfg = await config.obtain();
  try {
    return new Worker(cfg.workerPath);
  } finally {
    config.release(cfg);
  }
};

const terminateWorker = async (worker, { logger }) => {
  const log = await logger.obtain();
  log.log('Terminating worker');
  logger.release(log);
  worker.terminate();
};

const WorkerPoolProvider = Provider.fromPool(
  createWorker, 
  terminateWorker, 
  {
    size: 4, 
    deps: ['config', 'logger'] // Dependency providers passed to create/destroy
  }
);
```

### Reference Counted

Use `Provider.fromRefCounted` for resources that should be created when first needed and destroyed when no longer in use.

```javascript
import { Provider } from '@3sln/ngin';

const createSocket = async () => {
  const ws = new WebSocket('ws://example.com');
  await new Promise(resolve => ws.onopen = resolve);
  return ws;
};
const closeSocket = (ws) => ws.close();

const SocketProvider = Provider.fromRefCounted(createSocket, closeSocket);
```

### Dependency Lifetimes

Every *resource manager* — a provider you write by hand, or a `create` /
`destroy` / `dispose` callback you give to one of the factories — receives its
dependencies as **providers**, and decides how long to hold each one.

That distinction matters. A resource built by `create` usually outlives the
call, so it has to be able to keep a dependency for its own lifetime: obtain in
`create`, release in `destroy`. Being handed an already-obtained resource
instead would mean the resource is released the moment `create` returns, while
the thing that depends on it is still running.

*Consumers* — actions, queries and interceptors — are the other way around.
They do not manage lifetimes, so they receive already-obtained **resources**,
released for them when their work finishes.

## The Container

A `Container` instantiates a graph of providers -- each one exactly once, with
its own dependencies injected -- and hands out their resources.

```javascript
import { Container, Provider } from '@3sln/ngin/providers';

const container = new Container({
  providers: {
    config: ConfigProvider,
    api: ApiProvider,
  },
});

// Scoped: obtain, run, release -- even if the callback throws.
const users = await container.use(['api'], ({ api }) => api.getUsers());

// Manual, for work that outlives a single call.
const lease = await container.lease(['api'], { config: { verbose: true } });
lease.resources.api.subscribe(...);
await lease.release();   // idempotent

await container.dispose();  // flush, then dispose, dependents first
```

Constructing a container throws on a missing dependency
(`Dependency not found: x`) or a cycle
(`Cyclic dependency detected: a -> b -> a`).

## Provider Options

Consumers (Actions/Queries) can pass options to providers.

```javascript
class TimeoutProvider extends Provider {
  obtain(options) {
    return { timeout: options.timeout || 1000 };
  }
}

class MyAction extends Action {
  static deps = {
    settings: { timeout: 5000 } // Pass options here
  };
  
  execute({ settings }) {
    console.log(settings.timeout); // 5000
  }
}
```
