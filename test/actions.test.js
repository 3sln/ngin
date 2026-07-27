import { test, expect, mock } from 'bun:test';
import { Container, Provider } from '../src/providers.js';
import { Action, Dispatcher } from '../src/actions.js';

const settled = (feed) =>
  new Promise((resolve) => {
    feed.addEventListener('complete', () => resolve(null), { once: true });
    feed.addEventListener('error', (event) => resolve(event.error), { once: true });
  });

test('dispatcher works with providers alone, no queries involved', async () => {
  const container = new Container({
    providers: { greeting: Provider.fromSingleton('hello') },
  });
  const dispatcher = new Dispatcher({ container });

  let seen;
  const feed = dispatcher.dispatch(
    new (class extends Action {
      static deps = ['greeting'];
      execute({ greeting }) {
        seen = greeting;
      }
    })()
  );

  expect(await settled(feed)).toBeNull();
  expect(seen).toBe('hello');
  expect(dispatcher.container).toBe(container);
  expect(dispatcher.feed).toBe(container.feed);
});

test('dispatcher can be constructed with no container at all', async () => {
  const dispatcher = new Dispatcher();
  const feed = dispatcher.dispatch(
    new (class extends Action {
      execute() {}
    })()
  );
  expect(await settled(feed)).toBeNull();
});

test('instance deps override static deps of the same name', async () => {
  const container = new Container({
    providers: {
      cfg: class extends Provider {
        async obtain(options = {}) {
          return options.value ?? 'default';
        }
      },
    },
  });

  let seen;
  const action = new (class extends Action {
    static deps = ['cfg'];
    deps = { cfg: { value: 'overridden' } };
    execute({ cfg }) {
      seen = cfg;
    }
  })();

  const feed = new Dispatcher({ container }).dispatch(action);
  expect(await settled(feed)).toBeNull();
  expect(seen).toBe('overridden');
});

test('resources are released even when execute throws', async () => {
  const release = mock();
  const container = new Container({
    providers: {
      thing: class extends Provider {
        async obtain() {
          return 'thing';
        }
        release(resource) {
          release(resource);
        }
      },
    },
  });

  const feed = new Dispatcher({ container }).dispatch(
    new (class extends Action {
      static deps = ['thing'];
      execute() {
        throw new Error('kaboom');
      }
    })()
  );

  const error = await settled(feed);
  expect(error.message).toBe('kaboom');
  expect(release).toHaveBeenCalledTimes(1);
});

test('error event carries the error and its message', async () => {
  const dispatcher = new Dispatcher();
  const feed = dispatcher.dispatch(
    new (class extends Action {
      execute() {
        throw new Error('detailed');
      }
    })()
  );

  const event = await new Promise((resolve) =>
    feed.addEventListener('error', resolve, { once: true })
  );
  expect(event.error).toBeInstanceOf(Error);
  expect(event.error.message).toBe('detailed');
  expect(event.message).toBe('detailed');
});

test('a non-Error thrown value still produces a usable error event', async () => {
  const feed = new Dispatcher().dispatch(
    new (class extends Action {
      execute() {
        throw 'just a string';
      }
    })()
  );

  const event = await new Promise((resolve) =>
    feed.addEventListener('error', resolve, { once: true })
  );
  expect(event.error).toBe('just a string');
  expect(event.message).toBe('just a string');
});

test('interceptors thread state through enter, execute and leave', async () => {
  const seen = {};

  const dispatcher = new Dispatcher({
    interceptors: [
      {
        enter: (_, { state }) => ({ ...state, depth: 1 }),
        leave: (_, { state }) => {
          seen.leave = state;
        },
      },
      {
        enter: (_, { state }) => ({ ...state, depth: state.depth + 1 }),
      },
    ],
  });

  const feed = dispatcher.dispatch(
    new (class extends Action {
      execute(_, { state }) {
        seen.execute = state;
      }
    })()
  );

  expect(await settled(feed)).toBeNull();
  expect(seen.execute).toEqual({ depth: 2 });
  expect(seen.leave).toEqual({ depth: 2 });
});

test('an interceptor that fails on enter is still unwound', async () => {
  const log = [];
  const dispatcher = new Dispatcher({
    interceptors: [
      {
        enter: () => log.push('outer:enter'),
        error: () => log.push('outer:error'),
        leave: () => log.push('outer:leave'),
      },
      {
        enter: () => {
          log.push('inner:enter');
          throw new Error('enter failed');
        },
        error: () => log.push('inner:error'),
      },
    ],
  });

  const feed = dispatcher.dispatch(
    new (class extends Action {
      execute() {
        log.push('execute');
      }
    })()
  );

  const error = await settled(feed);
  expect(error.message).toBe('enter failed');
  expect(log).toEqual(['outer:enter', 'inner:enter', 'inner:error', 'outer:error']);
});

test('an interceptor error context exposes both feeds', async () => {
  let context;
  const dispatcher = new Dispatcher({
    interceptors: [
      {
        error: (_, ctx) => {
          context = ctx;
        },
      },
    ],
  });

  const feed = dispatcher.dispatch(
    new (class extends Action {
      execute() {
        throw new Error('x');
      }
    })()
  );

  await settled(feed);
  expect(context.dispatchFeed).toBe(feed);
  expect(context.engineFeed).toBe(dispatcher.feed);
});

test('mutating the interceptor list after construction has no effect', async () => {
  const interceptors = [];
  const dispatcher = new Dispatcher({ interceptors });
  interceptors.push({
    enter: () => {
      throw new Error('should not run');
    },
  });

  const feed = dispatcher.dispatch(
    new (class extends Action {
      execute() {}
    })()
  );
  expect(await settled(feed)).toBeNull();
});
