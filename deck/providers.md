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

Use `Provider.fromPool` to manage a pool of resources. This is useful for things like database connections or workers. You can also specify dependencies that will be passed to the `create` and `destroy` functions.

```javascript
import { Provider } from '@3sln/ngin';

const createWorker = async ({ config }) => {
  return new Worker(config.workerPath);
};

const terminateWorker = (worker, { logger }) => {
  logger.log('Terminating worker');
  worker.terminate();
};

const WorkerPoolProvider = Provider.fromPool(
  createWorker, 
  terminateWorker, 
  {
    size: 4, 
    deps: ['config', 'logger'] // Dependencies passed to create/destroy
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

> The `deps` given to a built-in factory arrive at `create` and `destroy` as
> *resources*, already obtained and released again around the call. Providers
> you write by hand receive the dependency *providers* in their constructor
> instead, and manage those lifecycles themselves.

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
