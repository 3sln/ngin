import { test, expect, mock, spyOn } from 'bun:test';
import { Container, Provider } from '../src/providers.js';
import { Action, Dispatcher } from '../src/actions.js';
import { Query, QueryStore } from '../src/queries.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('query store works with providers alone, no dispatcher involved', async () => {
  const container = new Container({
    providers: { source: Provider.fromSingleton({ value: 42 }) },
  });
  const store = new QueryStore({ container });

  const query = new (class extends Query {
    static deps = ['source'];
    boot({ source }, { notify }) {
      notify(source.value);
    }
  })();

  const received = [];
  const handle = store.query(query);
  handle.subscribe((value) => received.push(value));

  expect(await handle.peek()).toBe(42);
  expect(received).toEqual([42]);
  expect(store.container).toBe(container);
  expect(store.feed).toBe(container.feed);
});

test('a query that fails to boot does not hang peek', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const store = new QueryStore();
    const query = new (class extends Query {
      boot() {
        throw new Error('boot failed');
      }
      async fetch() {
        return 'fetched';
      }
    })();

    const handle = store.query(query);
    handle.subscribe(() => {});

    expect(await handle.peek()).toBe('fetched');
    expect(errors).toHaveBeenCalled();
  } finally {
    errors.mockRestore();
  }
});

test('a failed boot releases the resources it obtained', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  try {
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
    const store = new QueryStore({ container });

    const query = new (class extends Query {
      static deps = ['thing'];
      boot() {
        throw new Error('boot failed');
      }
    })();

    store.query(query).subscribe(() => {});
    await tick();

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenLastCalledWith('thing');
  } finally {
    errors.mockRestore();
  }
});

test('unsubscribing twice kills the query only once', async () => {
  const store = new QueryStore();
  const kill = mock();
  const query = new (class extends Query {
    boot(_, { notify }) {
      notify('v');
    }
    kill = kill;
  })();

  const subscription = store.query(query).subscribe(() => {});
  await tick();

  subscription.unsubscribe();
  expect(subscription.closed).toBe(true);
  subscription.unsubscribe();
  await tick();

  expect(kill).toHaveBeenCalledTimes(1);
});

test('unsubscribing before boot finishes still tears down cleanly', async () => {
  const release = mock();
  const order = [];

  const container = new Container({
    providers: {
      slow: class extends Provider {
        async obtain() {
          await tick(2);
          return 'slow';
        }
        release(resource) {
          release(resource);
        }
      },
    },
  });
  const store = new QueryStore({ container });

  const query = new (class extends Query {
    static deps = ['slow'];
    boot() {
      order.push('boot');
    }
    kill() {
      order.push('kill');
    }
  })();

  const subscription = store.query(query).subscribe(() => {});
  subscription.unsubscribe();

  await tick(10);

  expect(order).toEqual(['boot', 'kill']);
  expect(release).toHaveBeenCalledTimes(1);
});

test('a stale notify captured during boot cannot resurrect a dead query', async () => {
  const store = new QueryStore();
  const next = mock();
  let leak;

  const query = new (class extends Query {
    boot(_, { notify }) {
      notify('a');
      leak = notify;
    }
  })();

  const subscription = store.query(query).subscribe({ next });
  await tick();

  subscription.unsubscribe();
  await tick();

  leak('b');
  expect(next).toHaveBeenCalledTimes(1);
});

test('observers still attached when a query dies get complete()', async () => {
  // Unsubscribing is not a completion for the unsubscriber (RxJS semantics),
  // but a query dying underneath a live observer is.
  const store = new QueryStore();
  const complete = mock();

  const query = new (class extends Query {
    boot(_, { notify }) {
      notify('a');
    }
  })();

  store.query(query).subscribe({ next() {}, complete });
  await tick();

  await store.dispose();
  expect(complete).toHaveBeenCalledTimes(1);
});

test('a throwing observer does not stop its peers', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const store = new QueryStore();
    const good = mock();

    const query = new (class extends Query {
      boot(_, { notify }) {
        notify('v');
      }
    })();

    const handle = store.query(query);
    handle.subscribe(() => {
      throw new Error('bad observer');
    });
    handle.subscribe(good);
    await tick();

    expect(good).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalled();
  } finally {
    errors.mockRestore();
  }
});

test('an observer unsubscribing mid-notify does not skip its peers', async () => {
  const store = new QueryStore();
  const seen = [];
  let notify;

  const query = new (class extends Query {
    boot(_, ctx) {
      notify = ctx.notify;
    }
  })();

  const handle = store.query(query);
  const first = handle.subscribe(() => first.unsubscribe());
  handle.subscribe((value) => seen.push(value));
  await tick();

  notify('v');
  expect(seen).toEqual(['v']);
});

test('peek without an active query and without fetch throws', async () => {
  const store = new QueryStore();
  class NoFetchQuery extends Query {
    boot() {}
  }

  await expect(store.query(new NoFetchQuery()).peek()).rejects.toThrow(
    'NoFetchQuery is not active and does not implement fetch()'
  );
});

test('peek releases its resources after fetching', async () => {
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

  const query = new (class extends Query {
    static deps = ['thing'];
    boot() {}
    async fetch({ thing }) {
      return thing.toUpperCase();
    }
  })();

  expect(await new QueryStore({ container }).query(query).peek()).toBe('THING');
  expect(release).toHaveBeenCalledTimes(1);
});

test('bootAction and killAction are routed through the dispatcher', async () => {
  const log = [];
  class BootAction extends Action {
    execute() {
      log.push('boot-action');
    }
  }
  class KillAction extends Action {
    execute() {
      log.push('kill-action');
    }
  }

  const container = new Container();
  const dispatcher = new Dispatcher({ container });
  const store = new QueryStore({ container, dispatcher });

  const query = new (class extends Query {
    bootAction = new BootAction();
    killAction = new KillAction();
    boot(_, { notify, bootFeed }) {
      log.push(bootFeed instanceof EventTarget ? 'has-boot-feed' : 'no-boot-feed');
      notify('v');
    }
    kill(_, { killFeed }) {
      log.push(killFeed instanceof EventTarget ? 'has-kill-feed' : 'no-kill-feed');
    }
  })();

  const subscription = store.query(query).subscribe(() => {});
  await tick();
  subscription.unsubscribe();
  await tick();

  expect(log).toEqual([
    'has-boot-feed',
    'boot-action',
    'has-kill-feed',
    'kill-action',
  ]);
});

test('a failing lifecycle action is reported rather than swallowed', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const container = new Container();
    const store = new QueryStore({
      container,
      dispatcher: new Dispatcher({ container }),
    });

    class FailingBootAction extends Action {
      execute() {
        throw new Error('the boot action blew up');
      }
    }

    const query = new (class DataQuery extends Query {
      bootAction = new FailingBootAction();
      boot(_, { notify }) {
        notify('v');
      }
    })();

    store.query(query).subscribe(() => {});
    await tick(5);

    const reported = errors.mock.calls.map(([err]) => err).find((err) => err?.cause);
    expect(reported.message).toBe('DataQuery bootAction (FailingBootAction) failed');
    expect(reported.cause.message).toBe('the boot action blew up');
  } finally {
    errors.mockRestore();
  }
});

test('peek waits for an active query that has not emitted yet', async () => {
  const store = new QueryStore();
  let notify;

  const query = new (class extends Query {
    boot(_, ctx) {
      notify = ctx.notify;
    }
    async fetch() {
      return 'fetched';
    }
  })();

  const handle = store.query(query);
  handle.subscribe(() => {});
  await tick();

  let settled = false;
  const peeked = handle.peek().then((value) => {
    settled = true;
    return value;
  });

  // Deliberately pending: an active query answers peek from itself, and this
  // one has not produced a value yet. fetch() must not be used as a shortcut.
  await tick(5);
  expect(settled).toBe(false);

  notify('live');
  expect(await peeked).toBe('live');
});

test('a lifecycle action without a dispatcher reports a clear error', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const store = new QueryStore();
    const query = new (class extends Query {
      bootAction = new (class extends Action {
        execute() {}
      })();
      boot() {}
    })();

    store.query(query).subscribe(() => {});
    await tick();

    expect(errors.mock.calls[0][0].message).toContain('no dispatcher');
  } finally {
    errors.mockRestore();
  }
});

test('a re-subscription after kill boots a fresh controller', async () => {
  const store = new QueryStore();
  let counter = 0;
  const query = new (class extends Query {
    boot(_, { notify }) {
      notify(counter++);
    }
  })();

  const handle = store.query(query);
  const first = handle.subscribe(() => {});
  await tick();
  first.unsubscribe();
  await tick();

  const seen = [];
  handle.subscribe((value) => seen.push(value));
  await tick();

  expect(seen).toEqual([1]);
});

test('dispose kills live queries and rejects further subscriptions', async () => {
  const store = new QueryStore();
  const kill = mock();
  const query = new (class extends Query {
    boot() {}
    kill = kill;
  })();

  store.query(query).subscribe(() => {});
  await store.dispose();
  await store.dispose();

  expect(kill).toHaveBeenCalledTimes(1);
  expect(() => store.query(query).subscribe(() => {})).toThrow('disposed');
});

test('query() rejects anything that is not a Query', () => {
  expect(() => new QueryStore().query({})).toThrow(
    'query() requires an instance of Query'
  );
});
