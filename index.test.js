import { test, describe, expect, mock } from 'bun:test';
import { Engine, Provider, Action, Query } from './index';

class MockProvider extends Provider {
  constructor(deps) {
    super(deps);
    this.resource = { id: Math.random() };
  }
  async obtain() {
    return this.resource;
  }
  release() {
  }
}

class MockAction extends Action {
  static deps = { 'mock': {} };
  constructor() {
    super();
    this.execute = mock(async (deps, { dispatchFeed }) => {
      dispatchFeed.dispatchEvent(
        new CustomEvent('action-executed', { detail: deps.mock })
      );
    });
  }
}

class MockErrorAction extends Action {
  static deps = {};
  async execute() {
    throw new Error('Action failed');
  }
}

class MockQuery extends Query {
  static deps = { 'mock': {} };
  constructor(notifyCallback) {
    super();
    this.notifyCallback = notifyCallback;
    this.boot = mock((deps, { bootFeed }) => {
      this.notifyCallback('booted');
      this.bootFeed = bootFeed;
    });
    this.kill = mock((deps, { killFeed }) => {
      this.killFeed = killFeed;
    });
  }
}

class MockBootAction extends Action {
  static deps = {};
  async execute(deps, feeds) {
    feeds.dispatchFeed.dispatchEvent(new CustomEvent('boot-action-completed'));
  }
}

class MockKillAction extends Action {
  static deps = {};
  async execute(deps, feeds) {
    feeds.dispatchFeed.dispatchEvent(new CustomEvent('kill-action-completed'));
  }
}

class MockInterceptor {
  static deps = {};
  enter = mock(async (deps, { state }) => {
    state.enterCalled = true;
  });
  leave = mock(async (deps, { state }) => {
    state.leaveCalled = true;
  });
  error = mock(async (deps, { error, handled }) => {
    error.handledByInterceptor = true;
    handled();
  });
}

// --- Test Suites ---

describe('Engine', () => {
  test('should throw an error on cyclic dependency', () => {
    class ProviderA extends Provider { static deps = ['b'] }
    class ProviderB extends Provider { static deps = ['a'] }
    expect(
      () => new Engine({ providers: { a: ProviderA, b: ProviderB } })
    ).toThrow('Cyclic dependency detected: a -> b -> a');
  });

  test('should throw an error on missing dependency', () => {
    class ProviderA extends Provider { static deps = ['non-existent'] }
    expect(
      () => new Engine({ providers: { a: ProviderA } })
    ).toThrow('Dependency not found: non-existent');
  });

  test('should dispatch a successful action and fire a complete event', async () => {
    const engine = new Engine({ providers: { mock: MockProvider } });
    const action = new MockAction();
    const feed = engine.dispatch(action);

    const promise = new Promise(resolve => feed.addEventListener('complete', resolve, { once: true }));
    await promise;

    expect(action.execute).toHaveBeenCalledTimes(1);
    expect(action.execute.mock.calls[0][0].mock).toBeInstanceOf(Object);
  });

  test('should dispatch an error action and fire an error event', () => {
    const engine = new Engine({ providers: {} });
    const action = new MockErrorAction();
    const feed = engine.dispatch(action);

    const promise = new Promise((resolve, reject) => {
      feed.addEventListener('error', e => reject(e.error), { once: true });
    });

    expect(promise).rejects.toThrow('Action failed');
  });

  test('should run interceptors in the correct order for a successful action', async () => {
    const interceptor = new MockInterceptor();
    const engine = new Engine({
      providers: { mock: MockProvider },
      interceptors: [interceptor]
    });
    const action = new MockAction();
    const feed = engine.dispatch(action);

    await new Promise(resolve => feed.addEventListener('complete', resolve, { once: true }));

    expect(interceptor.enter).toHaveBeenCalledTimes(1);
    expect(interceptor.leave).toHaveBeenCalledTimes(1);
    expect(interceptor.error).not.toHaveBeenCalled();
    expect(action.execute).toHaveBeenCalledTimes(1);
    expect(interceptor.leave.mock.calls[0][1].state.enterCalled).toBe(true);
  });

  test('should run interceptor error hook when an action fails', async () => {
    const interceptor = new MockInterceptor();
    const engine = new Engine({
      providers: {},
      interceptors: [interceptor]
    });
    const action = new MockErrorAction();
    const feed = engine.dispatch(action);

    const promise = new Promise(resolve => feed.addEventListener('complete', resolve, { once: true }));
    await promise;

    expect(interceptor.enter).toHaveBeenCalledTimes(1);
    expect(interceptor.error).toHaveBeenCalledTimes(1);
    expect(interceptor.leave).not.toHaveBeenCalled();
    expect(interceptor.error.mock.calls[0][1].error.handledByInterceptor).toBe(true);
  });

  test('should query a successful query and handle boot/kill feeds', async () => {
    const engine = new Engine({
      providers: { mock: MockProvider },
    });
    const query = new class extends MockQuery {
      static deps = { 'mock': {} };
      bootAction = new MockBootAction();
      killAction = new MockKillAction();
    }(mock());

    const feed = engine.query(query).subscribe({
      next: mock(),
      complete: mock(),
    });

    await new Promise(resolve => setTimeout(resolve, 10)); // Give time for async boot to run

    expect(query.notifyCallback).toHaveBeenCalledWith('booted');
    expect(query.bootFeed).toBeInstanceOf(EventTarget);
    expect(query.killFeed).toBeUndefined();

    await feed.unsubscribe();
    
    expect(query.kill).toHaveBeenCalledTimes(1);
    expect(query.bootFeed).toBeInstanceOf(EventTarget);
    expect(query.killFeed).toBeInstanceOf(EventTarget);
  });

  test('should throw a TypeError if dispatch is called with a non-Action', () => {
    const engine = new Engine({ providers: {} });
    expect(() => engine.dispatch({})).toThrow(TypeError);
    expect(() => engine.dispatch({})).toThrow('dispatch() requires an instance of Action.');
  });

  test('should throw a TypeError if query is called with a non-Query', () => {
    const engine = new Engine({ providers: {} });
    expect(() => engine.query({})).toThrow(TypeError);
    expect(() => engine.query({})).toThrow('query() requires an instance of Query.');
  });
});

describe('Provider.fromSingleton', () => {
  test('should always return the same resource instance', async () => {
    const sharedResource = { id: 1 };
    const singletonProvider = Provider.fromSingleton(sharedResource);

    const resource1 = await singletonProvider.obtain();
    const resource2 = await singletonProvider.obtain();

    expect(resource1).toBe(sharedResource);
    expect(resource2).toBe(sharedResource);
    expect(resource1).toBe(resource2);
  });

  test('release should be a no-op', async () => {
    const mockDestroy = mock();
    const singletonProvider = Provider.fromSingleton({ destroy: mockDestroy });
    const resource = await singletonProvider.obtain();
    singletonProvider.release(resource);
    expect(mockDestroy).not.toHaveBeenCalled();
  });
});

describe('Provider.fromPool', () => {
  const mockCreate = mock(async () => ({ id: Math.random() }));
  const mockDestroy = mock();
  const poolProvider = Provider.fromPool(mockCreate, mockDestroy, 2);
  let resource1, resource2;

  test('should create and obtain resources up to pool size', async () => {
    resource1 = await poolProvider.obtain();
    resource2 = await poolProvider.obtain();
    const resourcePromise = poolProvider.obtain();

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(resource1).not.toBe(resource2);
    
    poolProvider.release(resource1);
    expect(mockDestroy).not.toHaveBeenCalled();

    // Release should unblock the waiting promise
    const originalResource1 = resource1;
    resource1 = await resourcePromise;
    expect(resource1).toBe(originalResource1);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  test('should destroy resources on release', async () => {
    poolProvider.release(resource1);
    poolProvider.dispose();
    expect(mockDestroy).toHaveBeenCalledTimes(1);
    poolProvider.release(resource2);
    expect(mockDestroy).toHaveBeenCalledTimes(2);
  });
});

describe('Provider.fromRefCounted', () => {
  test('should create the resource on first obtain and destroy on last release', async () => {
    const mockCreate = mock(async () => ({ id: Math.random() }));
    const mockDestroy = mock();
    const refCountedProvider = Provider.fromRefCounted(mockCreate, mockDestroy);

    const resource1 = await refCountedProvider.obtain();
    const resource2 = await refCountedProvider.obtain();
    
    // Resource should be created only once
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(resource1).toBe(resource2);

    refCountedProvider.release();
    // Not yet destroyed
    expect(mockDestroy).not.toHaveBeenCalled();

    refCountedProvider.release();
    // Now destroyed
    await new Promise(process.nextTick); // Wait for the async destroy to run
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  test('should handle concurrent obtain calls correctly', async () => {
    const mockCreate = mock(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return { id: Math.random() };
    });
    const mockDestroy = mock();
    const refCountedProvider = Provider.fromRefCounted(mockCreate, mockDestroy);

    const promise1 = refCountedProvider.obtain();
    const promise2 = refCountedProvider.obtain();

    const [resource1, resource2] = await Promise.all([promise1, promise2]);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(resource1).toBe(resource2);
  });
});
