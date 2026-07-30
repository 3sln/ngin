// Interceptors wrap queries the way they wrap actions: enter on the way in,
// exactly one unwind hook on the way out.  A live query stretches that over its
// whole lifetime -- enter at boot, leave at kill -- and a query answered by
// `fetch` is the same shape as a dispatch: enter, fetch, leave.
//
// The context names which of the two a hook was called for, so one interceptor
// can be registered for both and tell them apart.

import { test, expect, mock, spyOn } from 'bun:test';
import { Container, Provider } from '../src/providers.js';
import { Action, Dispatcher } from '../src/actions.js';
import { Query, QueryStore } from '../src/queries.js';
import { Engine } from '../src/engine.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

class LiveQuery extends Query {
  boot(_, { notify }) {
    notify('v');
  }
}

/** A one-shot: subscribing fetches once, emits, and completes. */
class ReadQuery extends Query {
  async fetch() {
    return 'read';
  }
}

const quiet = async (fn) => {
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await fn(errors);
  } finally {
    errors.mockRestore();
  }
};

test('a live query enters at boot and leaves at kill', async () => {
  const log = [];
  const store = new QueryStore({
    interceptors: [
      { enter: () => log.push('outer:enter'), leave: () => log.push('outer:leave') },
      { enter: () => log.push('inner:enter'), leave: () => log.push('inner:leave') },
    ],
  });

  const query = new (class extends Query {
    boot(_, { notify }) {
      log.push('boot');
      notify('v');
    }
    kill() {
      log.push('kill');
    }
  })();

  const subscription = store.query(query).subscribe(() => {});
  await tick();
  expect(log).toEqual(['outer:enter', 'inner:enter', 'boot']);

  subscription.unsubscribe();
  await tick();
  expect(log).toEqual([
    'outer:enter',
    'inner:enter',
    'boot',
    'kill',
    'inner:leave',
    'outer:leave',
  ]);
});

test('the context names the query, and has no action on it', async () => {
  const seen = [];
  const container = new Container();
  const store = new QueryStore({
    container,
    interceptors: [
      {
        enter: (_, context) => seen.push(context),
        leave: (_, context) => seen.push(context),
      },
    ],
  });

  const query = new LiveQuery();
  const subscription = store.query(query).subscribe(() => {});
  await tick();
  subscription.unsubscribe();
  await tick();

  expect(seen).toHaveLength(2);
  for (const context of seen) {
    expect(context.query).toBe(query);
    expect(context.action).toBeUndefined();
    expect(context.engineFeed).toBe(container.feed);
  }
});

test('one interceptor serves both layers, telling them apart by context', async () => {
  const log = [];
  const interceptor = {
    enter: (_, { action, query }) =>
      log.push(action ? `action:${action.constructor.name}` : `query:${query.constructor.name}`),
  };

  const container = new Container();
  const dispatcher = new Dispatcher({ container, interceptors: [interceptor] });
  const store = new QueryStore({ container, dispatcher, interceptors: [interceptor] });

  dispatcher.dispatch(
    new (class Refresh extends Action {
      execute() {}
    })()
  );
  store.query(new LiveQuery()).subscribe(() => {});
  await tick(5);

  expect(log.sort()).toEqual(['action:Refresh', 'query:LiveQuery']);
});

test('state threads from enter through boot and kill', async () => {
  const seen = {};
  const store = new QueryStore({
    interceptors: [
      {
        enter: (_, { state }) => ({ ...state, depth: 1 }),
        leave: (_, { state }) => {
          seen.leave = state;
        },
      },
      { enter: (_, { state }) => ({ ...state, depth: state.depth + 1 }) },
    ],
  });

  const query = new (class extends Query {
    boot(_, { notify, state }) {
      seen.boot = state;
      notify('v');
    }
    kill(_, { state }) {
      seen.kill = state;
    }
  })();

  const subscription = store.query(query).subscribe(() => {});
  await tick();
  subscription.unsubscribe();
  await tick();

  expect(seen.boot).toEqual({ depth: 2 });
  expect(seen.kill).toEqual({ depth: 2 });
  expect(seen.leave).toEqual({ depth: 2 });
});

test('an interceptor that refuses on enter stops the query before it starts', async () => {
  await quiet(async () => {
    const dispatched = mock();
    const log = [];
    const container = new Container();
    const store = new QueryStore({
      container,
      dispatcher: new Dispatcher({ container }),
      interceptors: [
        { enter: () => log.push('outer:enter'), error: () => log.push('outer:error') },
        {
          enter: () => {
            throw new Error('not allowed');
          },
          error: () => log.push('inner:error'),
        },
      ],
    });

    const query = new (class extends Query {
      bootAction = new (class extends Action {
        execute() {
          dispatched();
        }
      })();
      boot() {
        log.push('boot');
      }
    })();

    const errored = mock();
    store.query(query).subscribe({ next: () => {}, error: errored });
    await tick(5);

    expect(log).toEqual(['outer:enter', 'inner:error', 'outer:error']);
    expect(dispatched).not.toHaveBeenCalled();
    expect(errored.mock.calls[0][0].message).toBe('not allowed');
  });
});

test('a query that fails to boot unwinds through error, and only once', async () => {
  await quiet(async () => {
    const error = mock();
    const leave = mock();
    const store = new QueryStore({ interceptors: [{ error, leave }] });

    const query = new (class extends Query {
      boot() {
        throw new Error('boot failed');
      }
    })();

    const subscription = store.query(query).subscribe(() => {});
    await tick();

    // Killing a query that is already dead must not hand its interceptors a
    // second unwind: they closed what they opened the first time.
    subscription.unsubscribe();
    await tick();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][1].error.message).toBe('boot failed');
    expect(leave).not.toHaveBeenCalled();
  });
});

test('a one-shot query is entered, fetched and left', async () => {
  const log = [];
  const store = new QueryStore({
    interceptors: [
      { enter: () => log.push('enter'), leave: () => log.push('leave') },
    ],
  });

  const query = new (class extends Query {
    async fetch() {
      log.push('fetch');
      return 'read';
    }
  })();

  await new Promise((resolve) =>
    store.query(query).subscribe({
      next: (v) => log.push(`next:${v}`),
      complete: () => {
        log.push('complete');
        resolve();
      },
    })
  );

  // `leave` comes last: the query is left once it has let go of everything,
  // the same order an action's `leave` runs in after its lease is released.
  await tick();
  expect(log).toEqual(['enter', 'fetch', 'next:read', 'complete', 'leave']);
});

test('a peek that falls through to fetch is wrapped too', async () => {
  const log = [];
  const store = new QueryStore({
    interceptors: [
      {
        enter: (_, { query }) => log.push(`enter:${query.constructor.name}`),
        // Returning a value from a hook must not become the peeked value.
        leave: () => {
          log.push('leave');
          return { replaced: true };
        },
      },
    ],
  });

  expect(await store.query(new ReadQuery()).peek()).toBe('read');
  expect(log).toEqual(['enter:ReadQuery', 'leave']);
});

test('a peek answered by an active query does not re-enter the stack', async () => {
  // The query was entered when it booted; peeking at a value it already has is
  // not a second use of it.
  const enter = mock();
  const store = new QueryStore({ interceptors: [{ enter }] });

  const handle = store.query(new LiveQuery());
  handle.subscribe(() => {});
  await tick();

  expect(await handle.peek()).toBe('v');
  expect(enter).toHaveBeenCalledTimes(1);
});

test('a second subscriber joins the query rather than entering it again', async () => {
  // What a usage counter needs to know: `enter` counts realizations of a query,
  // not subscriptions to one, and `leave` waits for the last observer.
  const enter = mock();
  const leave = mock();
  const store = new QueryStore({ interceptors: [{ enter, leave }] });

  const handle = store.query(new LiveQuery());
  const first = handle.subscribe(() => {});
  const second = handle.subscribe(() => {});
  await tick();

  expect(enter).toHaveBeenCalledTimes(1);

  first.unsubscribe();
  await tick();
  expect(leave).not.toHaveBeenCalled();

  second.unsubscribe();
  await tick();
  expect(leave).toHaveBeenCalledTimes(1);
});

test('a lifecycle action runs the stack again, nested inside the query', async () => {
  const log = [];
  const interceptor = {
    enter: (_, { action }) => log.push(`enter:${action ? 'action' : 'query'}`),
    leave: (_, { action }) => log.push(`leave:${action ? 'action' : 'query'}`),
  };

  const container = new Container();
  const store = new QueryStore({
    container,
    dispatcher: new Dispatcher({ container, interceptors: [interceptor] }),
    interceptors: [interceptor],
  });

  const query = new (class extends Query {
    bootAction = new (class extends Action {
      execute() {}
    })();
    boot(_, { notify }) {
      notify('v');
    }
  })();

  const subscription = store.query(query).subscribe(() => {});
  await tick(5);
  subscription.unsubscribe();
  await tick(5);

  expect(log).toEqual([
    'enter:query',
    'enter:action',
    'leave:action',
    'leave:query',
  ]);
});

test('an unwinding hook that throws fails the peek it was wrapping', async () => {
  // The same rule a dispatch follows: a `leave` that throws fails the work it
  // was leaving, even though the fetch itself succeeded.
  const store = new QueryStore({
    interceptors: [
      {
        leave: () => {
          throw new Error('leave blew up');
        },
      },
    ],
  });

  await expect(store.query(new ReadQuery()).peek()).rejects.toThrow('leave blew up');
});

test('a fetch that throws reaches the error hook and the subscriber', async () => {
  await quiet(async () => {
    const error = mock();
    const store = new QueryStore({ interceptors: [{ error }] });

    const query = new (class extends Query {
      async fetch() {
        throw new Error('the database was not up');
      }
    })();

    const seen = await new Promise((resolve) =>
      store.query(query).subscribe({ error: resolve })
    );

    expect(seen.message).toBe('the database was not up');
    await tick();
    expect(error.mock.calls[0][1].error).toBe(seen);
  });
});

test('interceptors do not touch the values a query emits', async () => {
  const store = new QueryStore({
    interceptors: [
      {
        enter: () => ({ tagged: true }),
        leave: () => 'ignored',
      },
    ],
  });

  const seen = [];
  const query = new (class extends Query {
    boot(_, { notify }) {
      notify(1);
      notify(2);
    }
  })();

  const subscription = store.query(query).subscribe((value) => seen.push(value));
  await tick();
  subscription.unsubscribe();
  await tick();

  expect(seen).toEqual([1, 2]);
});

test('interceptor dependencies are injected and released around each hook', async () => {
  const release = mock();
  const container = new Container({
    providers: {
      audit: class extends Provider {
        async obtain() {
          return { log: mock() };
        }
        release(resource) {
          release(resource);
        }
      },
    },
  });

  const seen = [];
  const store = new QueryStore({
    container,
    interceptors: [
      {
        deps: ['audit'],
        enter: ({ audit }) => seen.push(audit),
        leave: ({ audit }) => seen.push(audit),
      },
    ],
  });

  const subscription = store.query(new LiveQuery()).subscribe(() => {});
  await tick();
  subscription.unsubscribe();
  await tick();

  expect(seen).toHaveLength(2);
  expect(release).toHaveBeenCalledTimes(2);
});

test('an unwinding hook that throws is reported rather than swallowed', async () => {
  await quiet(async (errors) => {
    const store = new QueryStore({
      interceptors: [
        {
          leave: () => {
            throw new Error('leave blew up');
          },
        },
      ],
    });

    const subscription = store.query(new LiveQuery()).subscribe(() => {});
    await tick();
    subscription.unsubscribe();
    await tick();

    const reported = errors.mock.calls.map(([err]) => err?.message);
    expect(reported).toContain('leave blew up');
  });
});

test('disposing the store unwinds the queries it kills', async () => {
  const leave = mock();
  const store = new QueryStore({ interceptors: [{ leave }] });

  store.query(new LiveQuery()).subscribe(() => {});
  await tick();
  await store.dispose();

  expect(leave).toHaveBeenCalledTimes(1);
});

test('mutating the interceptor list after construction has no effect', async () => {
  const interceptors = [];
  const store = new QueryStore({ interceptors });
  interceptors.push({
    enter: () => {
      throw new Error('should not run');
    },
  });

  const seen = [];
  store.query(new LiveQuery()).subscribe((value) => seen.push(value));
  await tick();

  expect(seen).toEqual(['v']);
});

test('an engine registers its interceptors with both layers', async () => {
  const log = [];
  const engine = new Engine({
    interceptors: [
      {
        enter: (_, { action }) => log.push(action ? 'action' : 'query'),
      },
    ],
  });

  engine.dispatch(
    new (class extends Action {
      execute() {}
    })()
  );
  engine.query(new LiveQuery()).subscribe(() => {});
  await tick(5);

  expect(log.sort()).toEqual(['action', 'query']);
  await engine.dispose();
});
