import { test, expect, mock } from 'bun:test';
import { Engine, Provider, Action, Query } from './index';

test('engine throws on cyclic dependency', () => {
  class ProviderA extends Provider {
    static deps = ['b']
  }
  class ProviderB extends Provider {
    static deps = ['a']
  }

  expect(
    () => new Engine({
      providers: { a: ProviderA, b: ProviderB }
    })
  ).toThrow('Cyclic dependency detected: a -> b -> a');
});

test('engine throws on missing dependency', () => {
  class ProviderA extends Provider {
    static deps = ['non-existent']
  }

  expect(
    () => new Engine({
      providers: { a: ProviderA }
    })
  ).toThrow('Dependency not found: non-existent');
});

test('action dispatch', async () => {
  const engine = new Engine({ providers: {} });
  const feed = engine.dispatch(new class extends Action {
    execute(_, { dispatchFeed }) {
      dispatchFeed.dispatchEvent(new Event('executed'));
    }
  }());

  const executed = Promise.withResolvers();
  const completed = Promise.withResolvers();

  feed.addEventListener('executed', () => {
    executed.resolve();
  }, {
    once: true
  });

  feed.addEventListener('complete', () => {
    completed.resolve();
  }, {
    once: true
  });

  await executed.promise;
  await completed.promise;
});

test('action dependency injection', async () => {
  const resource = mock();
  const engine = new Engine({
    providers: {
      x: Provider.fromSingleton(resource)
    }
  });

  const feed = engine.dispatch(new class extends Action {
    static deps = [ 'x' ];

    execute({ x }) {
      x();
    }
  }());

  await new Promise(
    resolve => feed.addEventListener('complete', resolve, { once: true })
  );

  expect(resource).toHaveBeenCalledTimes(1);
});

test('action execution error produces error event', async () => {
  const engine = new Engine({});
  const feed = engine.dispatch(new class extends Action {
    execute() {
      throw new Error('errored');
    }
  }());

  const error = Promise.withResolvers();

  feed.addEventListener('error', event => {
    error.reject(event.error);
  }, {
    once: true
  });

  expect(async () => await error.promise).toThrow('errored');
});

test('interceptors enter/leave order', async () => {
  const log = [];

  const interceptor1 = {
    enter: () => { log.push('interceptor1:enter'); },
    leave: () => { log.push('interceptor1:leave'); },
  };
  const interceptor2 = {
    enter: () => { log.push('interceptor2:enter'); },
    leave: () => { log.push('interceptor2:leave'); },
  };

  const engine = new Engine({
    interceptors: [
      interceptor1,
      interceptor2,
    ]
  });

  const feed = engine.dispatch(new class extends Action {
    execute() {
      log.push('execute');
    }
  }());

  await new Promise(
    resolve => feed.addEventListener('complete', resolve, { once: true })
  );

  expect(log).toEqual([
    'interceptor1:enter',
    'interceptor2:enter',
    'execute',
    'interceptor2:leave',
    'interceptor1:leave',
  ]);
});

test('interceptors errors', async () => {
  const log = [];

  const interceptor1 = {
    enter: () => { log.push('interceptor1:enter'); },
    leave: () => { log.push('interceptor1:leave'); },
    error: () => { log.push('interceptor1:error'); },
  };
  const interceptor2 = {
    enter: () => { log.push('interceptor2:enter'); },
    leave: () => { log.push('interceptor2:leave'); },
    error: (_, { handled }) => { log.push('interceptor2:error'); handled(); },
  };
  const interceptor3 = {
    enter: () => { log.push('interceptor3:enter'); },
    leave: () => { log.push('interceptor3:leave'); },
    error: () => { log.push('interceptor3:error'); },
  };

  const engine = new Engine({
    interceptors: [
      interceptor1,
      interceptor2,
      interceptor3,
    ]
  });

  const feed = engine.dispatch(new class extends Action {
    execute() {
      log.push('errored');
      throw new Error('errored');
    }
  }());

  await new Promise(
    resolve => feed.addEventListener('complete', resolve, { once: true })
  );

  expect(log).toEqual([
    'interceptor1:enter',
    'interceptor2:enter',
    'interceptor3:enter',
    'errored',
    'interceptor3:error',
    'interceptor2:error',
    'interceptor1:leave',
  ]);
});

test('interceptor dependencies', async () => {
  const x = {
    enter: mock(),
    leave: mock(),
  };

  const interceptor = {
    deps: ['x'],
    enter: ({ x }) => { x.enter(); },
    leave: ({ x }) => { x.leave(); },
  };

  const engine = new Engine({
    providers: {
      x: Provider.fromSingleton(x),
    },
    interceptors: [
      interceptor,
    ],
  });

  const feed = engine.dispatch(new class extends Action {
    execute() {}
  }());

  await new Promise(
    resolve => feed.addEventListener('complete', resolve, { once: true })
  );

  expect(x.enter).toHaveBeenCalledTimes(1);
  expect(x.leave).toHaveBeenCalledTimes(1);
});

test('query lifecycle', async () => {
  const engine = new Engine({});
  const received = [];

  const query = new class extends Query {
    boot = mock((_, { notify }) => {
      setTimeout(() => notify('a'), 0);
      setTimeout(() => notify('b'), 1);
      setTimeout(() => notify('c'), 2);
    });
    kill = mock();
    fetch = mock(async () => 'x');
  }();

  const h = engine.query(query);
  const { unsubscribe } = h.subscribe({
    next(x) {
      received.push(x);
    },
  });

  expect(await h.peek()).toBe('a');
  expect(query.fetch).not.toHaveBeenCalled();

  setTimeout(() => unsubscribe(), 5);

  await new Promise(resolve => setTimeout(resolve, 10));

  expect(query.boot).toHaveBeenCalledTimes(1);
  expect(query.kill).toHaveBeenCalledTimes(1);
  expect(query.fetch).not.toHaveBeenCalled();
  expect(received).toEqual(['a', 'b', 'c']);

  expect(await h.peek()).toBe('x');
  expect(query.fetch).toHaveBeenCalledTimes(1);
});

test('query reuse', async () => {
  const engine = new Engine({});
  let counter = 0;

  const query = new class extends Query {
    boot = mock((_, { notify }) => {
      notify(counter++);
    });
    kill = mock();
  }();

  const h1 = engine.query(query);
  const h2 = engine.query(query);

  const h1s = h1.subscribe({ next() {} });
  const h2s = h2.subscribe({ next() {} });

  const h1p = await h1.peek();
  const h2p = await h2.peek();
  expect(h1p).toBe(h2p);

  h1s.unsubscribe();
  h2s.unsubscribe();

  expect(query.boot).toHaveBeenCalledTimes(1);
  expect(query.kill).toHaveBeenCalledTimes(1);
});

test('kill queries on engine disposal', async () => {
  const engine = new Engine({});
  const query = new class extends Query{
    boot = mock();
    kill = mock();
  }();

  engine.query(query).subscribe({ next(){} });

  expect(query.kill).not.toHaveBeenCalled();

  await engine.dispose();

  expect(query.kill).toHaveBeenCalledTimes(1);
  expect(query.boot).toHaveBeenCalledTimes(1);
});

test('throw when something other than action dispatched', () => {
  const engine = new Engine({});
  expect(() => engine.dispatch({}))
    .toThrow('dispatch() requires an instance of Action');
});

test('throw when something other than a query is queried', () => {
  const engine = new Engine({});
  expect(() => engine.query({}))
    .toThrow('query() requires an instance of Query');
});

test('singleton provider', async () => {
  const sharedResource = { id: 1 };
  const singletonProvider = new (Provider.fromSingleton(sharedResource))();

  const resource1 = await singletonProvider.obtain();
  const resource2 = await singletonProvider.obtain();

  expect(resource1).toBe(sharedResource);
  expect(resource2).toBe(sharedResource);
  expect(resource1).toBe(resource2);
});

test('pool provider', async () => {
  const mockCreate = mock(async () => ({ id: Math.random() }));
  const mockDestroy = mock();
  const poolProvider = new (Provider.fromPool(mockCreate, mockDestroy, 2))();
  let resource1, resource2;

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

  poolProvider.release(resource1);
  poolProvider.dispose();
  expect(mockDestroy).toHaveBeenCalledTimes(1);
  poolProvider.release(resource2);
  expect(mockDestroy).toHaveBeenCalledTimes(2);
});

test('ref counted provider', async () => {
  const mockCreate = mock(async () => ({ id: Math.random() }));
  const mockDestroy = mock();
  const refCountedProvider = new (Provider.fromRefCounted(mockCreate, mockDestroy))();

  const resource1 = await refCountedProvider.obtain();
  const resource2 = await refCountedProvider.obtain();
  
  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(resource1).toBe(resource2);

  refCountedProvider.release();
  expect(mockDestroy).not.toHaveBeenCalled();

  refCountedProvider.release();
  await new Promise(process.nextTick);
  expect(mockDestroy).toHaveBeenCalledTimes(1);
});
