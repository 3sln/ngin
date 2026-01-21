# Providers

Providers are responsible for managing the lifecycle of resources. A resource can be anything: a service class, a database connection, a configuration object, or even a simple primitive.

`ngin` provides a base `Provider` class and several static helper methods for common patterns.

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
