import { test, expect, mock } from 'bun:test';
import { Engine, Container, Dispatcher, QueryStore, Provider, Action, Query } from '../src/index.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('engine exposes the layers it composed', () => {
  const engine = new Engine({ providers: { a: Provider.fromSingleton(1) } });

  expect(engine.container).toBeInstanceOf(Container);
  expect(engine.dispatcher).toBeInstanceOf(Dispatcher);
  expect(engine.queries).toBeInstanceOf(QueryStore);
  expect(engine.feed).toBe(engine.container.feed);
  expect(engine.dispatcher.container).toBe(engine.container);
  expect(engine.queries.container).toBe(engine.container);
});

test('engine accepts pre-built layers', async () => {
  const container = new Container({ providers: { a: Provider.fromSingleton('shared') } });
  const dispatcher = new Dispatcher({ container });
  const engine = new Engine({ container, dispatcher });

  expect(engine.container).toBe(container);
  expect(engine.dispatcher).toBe(dispatcher);

  let seen;
  const feed = engine.dispatch(
    new (class extends Action {
      static deps = ['a'];
      execute({ a }) {
        seen = a;
      }
    })()
  );
  await new Promise((resolve) => feed.addEventListener('complete', resolve, { once: true }));
  expect(seen).toBe('shared');
});

test('engine can be constructed with no configuration at all', async () => {
  const engine = new Engine();
  const feed = engine.dispatch(
    new (class extends Action {
      execute() {}
    })()
  );
  await new Promise((resolve) => feed.addEventListener('complete', resolve, { once: true }));
  await engine.dispose();
});

test('a query lifecycle action reaches the engine dispatcher', async () => {
  const executed = mock();
  const engine = new Engine();

  const query = new (class extends Query {
    bootAction = new (class extends Action {
      execute() {
        executed();
      }
    })();
    boot(_, { notify }) {
      notify('v');
    }
  })();

  engine.query(query).subscribe(() => {});
  await tick();

  expect(executed).toHaveBeenCalledTimes(1);
  await engine.dispose();
});

test('dispose is idempotent and runs queries before providers', async () => {
  const order = [];

  const engine = new Engine({
    providers: {
      thing: class extends Provider {
        async obtain() {
          return 'thing';
        }
        release() {
          order.push('release');
        }
        async dispose() {
          order.push('provider:dispose');
        }
      },
    },
  });

  const query = new (class extends Query {
    static deps = ['thing'];
    boot() {}
    kill() {
      order.push('query:kill');
    }
  })();

  engine.query(query).subscribe(() => {});
  await tick();

  await engine.dispose();
  await engine.dispose();

  expect(order).toEqual(['query:kill', 'release', 'provider:dispose']);
});

test('the legacy hooks.createQueryControllersMap option is still honoured', async () => {
  const created = mock(() => new Map());
  const engine = new Engine({ hooks: { createQueryControllersMap: created } });

  const query = new (class extends Query {
    boot(_, { notify }) {
      notify('v');
    }
  })();

  engine.query(query).subscribe(() => {});
  await tick();

  expect(created).toHaveBeenCalledTimes(1);
  await engine.dispose();
});

test('dispose waits for active actions and concurrent callers before destroying resources', async () => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const order = [];
  const resource = { disposed: false };
  const engine = new Engine({
    providers: {
      thing: Provider.fromSingleton(resource, {
        dispose(value) {
          value.disposed = true;
          order.push('dispose');
        },
      }),
    },
    interceptors: [{ leave() { order.push('leave'); } }],
  });
  const feed = engine.dispatch(new (class extends Action {
    static deps = ['thing'];
    async execute({ thing }) {
      started.resolve();
      await finish.promise;
      expect(thing.disposed).toBe(false);
      order.push('execute');
    }
  })());
  await started.promise;
  const disposal = engine.dispose();
  expect(engine.dispose()).toBe(disposal);
  await tick();
  expect(resource.disposed).toBe(false);
  expect(() => engine.dispatch(new Action())).toThrow('engine has been disposed');
  finish.resolve();
  await disposal;
  expect(feed.settled).toBe('complete');
  expect(order).toEqual(['execute', 'leave', 'dispose']);
});

test('dispose waits for scheduled actions, including failed actions', async () => {
  const order = [];
  const engine = new Engine({ providers: {
    thing: Provider.fromSingleton({}, { dispose() { order.push('dispose'); } }),
  } });
  const feed = engine.dispatch(new (class extends Action {
    static deps = ['thing'];
    execute() {
      order.push('execute');
      throw new Error('failed');
    }
  })());
  await engine.dispose();
  expect(feed.settled).toBe('error');
  expect(order).toEqual(['execute', 'dispose']);
  expect(() => engine.dispatcher.dispatch(new Action())).toThrow('dispatcher has been disposed');
});

test('dispose waits for an action still acquiring resources and for its abort cleanup', async () => {
  const obtaining = Promise.withResolvers();
  const acquired = Promise.withResolvers();
  const order = [];
  const engine = new Engine({ providers: {
    thing: class extends Provider {
      async obtain() {
        obtaining.resolve();
        await acquired.promise;
        return {};
      }
      release() { order.push('release'); }
      dispose() { order.push('dispose'); }
    },
  } });
  const feed = engine.dispatch(new (class extends Action {
    static deps = ['thing'];
    execute(_, { signal }) {
      expect(signal.aborted).toBe(true);
      order.push('execute');
    }
  })());
  await obtaining.promise;
  feed.abort();
  const disposal = engine.dispose();
  await tick();
  expect(order).toEqual([]);
  acquired.resolve();
  await disposal;
  expect(feed.settled).toBe('abort');
  expect(order).toEqual(['execute', 'release', 'dispose']);
});

test('dispose drains query kill actions before providers', async () => {
  const order = [];
  const engine = new Engine({ providers: {
    thing: Provider.fromSingleton({}, { dispose() { order.push('dispose'); } }),
  } });
  engine.query(new (class extends Query {
    killAction = new (class extends Action {
      static deps = ['thing'];
      async execute() {
        await tick();
        order.push('killAction');
      }
    })();
    boot() {}
  })()).subscribe(() => {});
  await tick();
  await engine.dispose();
  expect(order).toEqual(['killAction', 'dispose']);
});

test('aborting an active action does not let dispose skip interceptor cleanup', async () => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const cleaning = Promise.withResolvers();
  const cleaned = Promise.withResolvers();
  const disposed = mock();
  const engine = new Engine({
    providers: { thing: Provider.fromSingleton({}, { dispose: disposed }) },
    interceptors: [{ async abort() {
      cleaning.resolve();
      await cleaned.promise;
    } }],
  });
  const feed = engine.dispatch(new (class extends Action {
    static deps = ['thing'];
    async execute() {
      started.resolve();
      await finish.promise;
    }
  })());
  await started.promise;
  feed.abort();
  const disposal = engine.dispose();
  await tick();
  expect(disposed).not.toHaveBeenCalled();
  finish.resolve();
  await cleaning.promise;
  expect(disposed).not.toHaveBeenCalled();
  cleaned.resolve();
  await disposal;
  expect(feed.settled).toBe('abort');
  expect(disposed).toHaveBeenCalledTimes(1);
});
