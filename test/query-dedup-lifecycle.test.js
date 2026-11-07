import { test, expect, spyOn } from 'bun:test';
import { Container, Provider } from '../src/providers.js';
import { Query, QueryStore } from '../src/queries.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('equivalent live queries share one resource lease and interceptor lifetime', async () => {
  const order = [];
  const resource = {};
  const container = new Container({ providers: {
    resource: class extends Provider {
      obtain() { order.push('obtain'); return resource; }
      release(value) { expect(value).toBe(resource); order.push('release'); }
    },
  } });
  const store = new QueryStore({ container, interceptors: [{
    enter() { order.push('enter'); },
    leave() { order.push('leave'); },
  }] });
  class Live extends Query {
    static deps = ['resource'];
    dedupEquiv() { return true; }
    boot({ resource: value }, { notify }) { order.push('boot'); notify(value); }
    kill({ resource: value }) { expect(value).toBe(resource); order.push('kill'); }
  }
  const first = store.query(new Live()).subscribe(() => {});
  const second = store.query(new Live()).subscribe(() => {});
  await tick();
  expect(order).toEqual(['enter', 'obtain', 'boot']);
  first.unsubscribe();
  await tick();
  expect(order).toEqual(['enter', 'obtain', 'boot']);
  second.unsubscribe();
  await tick();
  expect(order).toEqual(['enter', 'obtain', 'boot', 'kill', 'release', 'leave']);
  await store.dispose();
  await container.dispose();
});

test('concurrent equivalent one-shot queries share a fetch and both complete', async () => {
  const fetching = Promise.withResolvers();
  const answer = Promise.withResolvers();
  let fetches = 0;
  class Read extends Query {
    dedupKey() { return 'bucket'; }
    dedupEquiv() { return true; }
    async fetch() { fetches++; fetching.resolve(); return await answer.promise; }
  }
  const store = new QueryStore();
  const first = [];
  const second = [];
  store.query(new Read()).subscribe({ next: (v) => first.push(v), complete: () => first.push('done') });
  await fetching.promise;
  store.query(new Read()).subscribe({ next: (v) => second.push(v), complete: () => second.push('done') });
  expect(fetches).toBe(1);
  answer.resolve(undefined);
  await tick();
  expect(first).toEqual([undefined, 'done']);
  expect(second).toEqual([undefined, 'done']);
  await store.dispose();
});

test('failed shared fetch releases its lease and allows a fresh equivalent query', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  const fetching = Promise.withResolvers();
  const answer = Promise.withResolvers();
  const failure = new Error('fetch failed');
  let obtains = 0;
  let releases = 0;
  let fetches = 0;
  const container = new Container({ providers: {
    resource: class extends Provider {
      obtain() { obtains++; return {}; }
      release() { releases++; }
    },
  } });
  class Read extends Query {
    static deps = ['resource'];
    dedupKey() { return 'same'; }
    dedupEquiv() { return true; }
    async fetch() {
      fetches++;
      if (fetches === 1) { fetching.resolve(); return await answer.promise; }
      return 'recovered';
    }
  }
  const store = new QueryStore({ container });
  try {
    const seen = [];
    store.query(new Read()).subscribe({ error: (error) => seen.push(error) });
    await fetching.promise;
    store.query(new Read()).subscribe({ error: (error) => seen.push(error) });
    answer.reject(failure);
    await tick();
    expect(seen).toEqual([failure, failure]);
    expect(fetches).toBe(1);
    expect(obtains).toBe(1);
    expect(releases).toBe(1);
    store.query(new Read()).subscribe((value) => seen.push(value));
    await tick();
    expect(seen).toEqual([failure, failure, 'recovered']);
    expect(fetches).toBe(2);
    expect(obtains).toBe(2);
    expect(releases).toBe(2);
  } finally {
    await store.dispose();
    await container.dispose();
    errors.mockRestore();
  }
});

test('late teardown of an evicted equivalent query preserves the replacement', async () => {
  const killing = Promise.withResolvers();
  const finishKill = Promise.withResolvers();
  let boots = 0;
  class Live extends Query {
    constructor(value, slowKill = false) { super(); this.value = value; this.slowKill = slowKill; }
    dedupKey() { return 'same'; }
    dedupEquiv() { return true; }
    boot(_, { notify }) { boots++; notify(this.value); }
    async kill() {
      if (this.slowKill) { killing.resolve(); await finishKill.promise; }
    }
  }
  const store = new QueryStore();
  const first = store.query(new Live('old', true)).subscribe(() => {});
  await tick();
  first.unsubscribe();
  await killing.promise;
  store.query(new Live('new')).subscribe(() => {});
  await tick();
  finishKill.resolve();
  await tick();
  const seen = [];
  store.query(new Live('unexpected')).subscribe((value) => seen.push(value));
  expect(seen).toEqual(['new']);
  expect(boots).toBe(2);
  await store.dispose();
});
