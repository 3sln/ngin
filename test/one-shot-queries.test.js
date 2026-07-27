// A query with `fetch` and no `boot` is a one-shot: subscribing fetches once,
// hands the value over, and completes.
//
// Before, the base class's `boot` threw "not implemented" — and that error went
// to `report()` rather than to the subscriber, so subscribing to a read-only
// query left it waiting for a value that was never coming. Silence is the worst
// answer available: no value, no error, nothing to log against the call.

import { test, expect } from 'bun:test';
import { Container, Provider } from '../src/providers.js';
import { Query, QueryStore } from '../src/queries.js';

const store = (providers = {}) => new QueryStore({ container: new Container({ providers }) });

class ReadItems extends Query {
  static deps = ['db'];
  constructor(collection = 'default') { super(); this.collection = collection; }
  async fetch({ db }) { return `${this.collection}:${db.read()}`; }
}

const db = (read = () => 'items') => ({ db: Provider.fromSingleton({ read }) });

/** Collect an observable's calls in order, resolving when it settles. */
function record(handle) {
  const calls = [];
  return new Promise((resolve) => {
    handle.subscribe({
      next: (v) => calls.push(['next', v]),
      error: (e) => { calls.push(['error', e.message]); resolve(calls); },
      complete: () => { calls.push(['complete']); resolve(calls); },
    });
  });
}

test('subscribing fetches once, emits, and completes', async () => {
  expect(await record(store(db()).query(new ReadItems()))).toEqual([
    ['next', 'default:items'],
    ['complete'],
  ]);
});

test('its declared dependencies are injected, same as a live query', async () => {
  const s = store(db(() => 'from-the-container'));
  expect(await record(s.query(new ReadItems('photos')))).toEqual([
    ['next', 'photos:from-the-container'],
    ['complete'],
  ]);
});

test('two subscribers arriving together share one fetch', async () => {
  let fetches = 0;
  class Counted extends Query {
    static deps = ['db'];
    async fetch({ db }) { fetches++; return db.read(); }
  }
  const s = store(db());
  const handle = s.query(new Counted());
  const [a, b] = await Promise.all([record(handle), record(handle)]);
  expect(a).toEqual([['next', 'items'], ['complete']]);
  expect(b).toEqual(a);
  expect(fetches).toBe(1);
});

test('a later subscribe fetches again rather than serving a stale value', async () => {
  // A one-shot has no way of learning that its answer changed, so keeping it
  // around would serve the first answer forever with nothing able to invalidate
  // it. Completing evicts it, and the next subscriber gets a fresh read.
  let value = 'first';
  const s = store(db(() => value));
  class Live extends Query { static deps = ['db']; async fetch({ db }) { return db.read(); } }

  expect(await record(s.query(new Live()))).toEqual([['next', 'first'], ['complete']]);
  value = 'second';
  expect(await record(s.query(new Live()))).toEqual([['next', 'second'], ['complete']]);
});

test('a fetch that throws reaches the subscriber as an error', async () => {
  // The failure this must not reproduce: an empty completion, indistinguishable
  // from a successful read that found nothing.
  class Broken extends Query {
    static deps = [];
    async fetch() { throw new Error('the database was not up'); }
  }
  expect(await record(store().query(new Broken()))).toEqual([
    ['error', 'the database was not up'],
  ]);
});

test('an observer with no error handler still completes, as it always did', async () => {
  // Existing consumers are unaffected: `error` is delivered only to observers
  // that asked for it.
  class Broken extends Query {
    static deps = [];
    async fetch() { throw new Error('nope'); }
  }
  const calls = [];
  await new Promise((resolve) => {
    store().query(new Broken()).subscribe({
      next: (v) => calls.push(['next', v]),
      complete: () => { calls.push(['complete']); resolve(); },
    });
  });
  expect(calls).toEqual([['complete']]);
});

test('a query with neither boot nor fetch says so', async () => {
  class Neither extends Query { static deps = []; }
  const calls = [];
  await new Promise((resolve) => {
    store().query(new Neither()).subscribe({
      error: (e) => { calls.push(e.message); resolve(); },
      complete: resolve,
    });
  });
  expect(calls[0]).toMatch(/implements neither boot\(\) nor fetch\(\)/);
});

test('peek still works, and still does not need a subscriber', async () => {
  expect(await store(db()).query(new ReadItems()).peek()).toBe('default:items');
});

test('a live query is untouched — boot still runs, and it keeps emitting', async () => {
  class Live extends Query {
    static deps = [];
    async boot(_, { notify }) { notify(1); notify(2); this.notify = notify; }
    async kill() {}
  }
  const seen = [];
  const instance = new Live();
  const sub = store().query(instance).subscribe((v) => seen.push(v));
  await new Promise((r) => setTimeout(r));
  instance.notify(3);
  expect(seen).toEqual([1, 2, 3]);
  sub.unsubscribe();
});

test('the one-shot released its lease, so the container can be disposed', async () => {
  let destroyed = 0;
  const container = new Container({
    providers: {
      db: Provider.fromLazySingleton(async () => ({ read: () => 'x' }), () => { destroyed++; }),
    },
  });
  const s = new QueryStore({ container });
  class Read extends Query { static deps = ['db']; async fetch({ db }) { return db.read(); } }
  await record(s.query(new Read()));
  await container.dispose();
  expect(destroyed).toBe(1);
});
