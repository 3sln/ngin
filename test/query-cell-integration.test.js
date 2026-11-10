import { test, expect, spyOn } from 'bun:test';
import { Engine, Provider, Query, QueryStore } from '../index.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('Cell and legacy observers share one resource and release only after both leave', async () => {
  let obtains = 0;
  let releases = 0;
  let boots = 0;
  let kills = 0;
  let emit;
  const engine = new Engine({ providers: {
    resource: class extends Provider {
      obtain() { obtains++; return {}; }
      release() { releases++; }
    },
  } });
  const query = new (class extends Query {
    static deps = ['resource'];
    boot(_, { notify }) { boots++; emit = notify; notify('first'); }
    kill() { kills++; }
  })();
  const handle = engine.query(query);
  expect(engine.query(query)).toBe(handle);
  const legacyValues = [];
  const legacy = handle.subscribe((value) => legacyValues.push(value));
  await tick();
  expect(handle.getValue()).toBe('first');
  const cellValues = [];
  const stop = handle.onDirty(() => cellValues.push(handle.getValue()));
  emit('second');
  expect(legacyValues).toEqual(['first', 'second']);
  expect(cellValues).toEqual(['first', 'second']);
  legacy.unsubscribe();
  await tick();
  expect([obtains, boots, releases, kills]).toEqual([1, 1, 0, 0]);
  stop();
  await tick();
  expect([obtains, boots, releases, kills]).toEqual([1, 1, 1, 1]);
  await engine.dispose();
});

test('equivalent Cell handles read shared active state and reconnect to fresh realizations', async () => {
  let boots = 0;
  class Live extends Query {
    dedupKey() { return 'same'; }
    dedupEquiv() { return true; }
    boot(_, { notify }) { notify(++boots); }
  }
  const store = new QueryStore();
  const first = store.query(new Live());
  const second = store.query(new Live());
  const readOnly = store.query(new Live());
  expect(readOnly.hasValue()).toBe(false);
  expect(readOnly.getValue()).toBeUndefined();
  expect(boots).toBe(0);
  const stopFirst = first.onDirty(() => {});
  await tick();
  expect(readOnly.hasValue()).toBe(true);
  expect(readOnly.getValue()).toBe(1);
  const stopSecond = second.onDirty(() => {});
  expect(second.getValue()).toBe(1);
  stopFirst();
  stopSecond();
  await tick();
  expect(first.getValue()).toBe(1);
  const stopAgain = second.onDirty(() => {});
  expect(first.hasValue()).toBe(false);
  expect(first.getValue()).toBeUndefined();
  await tick();
  expect(first.getValue()).toBe(2);
  expect(boots).toBe(2);
  stopAgain();
  await tick();
  await store.dispose();
});

test('undefined results differ from pending and undefined failures survive getValue', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  const store = new QueryStore();
  let attempts = 0;
  class Read extends Query {
    fetch() {
      attempts++;
      if (attempts === 1) throw undefined;
      return undefined;
    }
  }
  const handle = store.query(new Read());
  try {
    expect(handle.hasValue()).toBe(false);
    expect(handle.getValue()).toBeUndefined();
    const stop = handle.onDirty(() => {});
    await tick();
    let threw = false;
    try { handle.getValue(); } catch (error) { threw = true; expect(error).toBeUndefined(); }
    expect(threw).toBe(true);
    threw = false;
    try { handle.hasValue(); } catch (error) { threw = true; expect(error).toBeUndefined(); }
    expect(threw).toBe(true);
    stop();
    const stopAgain = handle.onDirty(() => {});
    expect(handle.hasValue()).toBe(false);
    expect(handle.getValue()).toBeUndefined();
    await tick();
    expect(handle.getValue()).toBeUndefined();
    expect(handle.hasValue()).toBe(true);
    expect(attempts).toBe(2);
    stopAgain();
  } finally {
    await store.dispose();
    logged.mockRestore();
  }
});

test('disposed stores reject additional Cell listeners even when an old listener remains', async () => {
  const store = new QueryStore();
  const handle = store.query(new (class extends Query {
    boot(_, { notify }) { notify('value'); }
  })());
  const stop = handle.onDirty(() => {});
  await tick();
  await store.dispose();
  expect(() => handle.onDirty(() => {})).toThrow('disposed');
  stop();
  expect(() => handle.onDirty(() => {})).toThrow('disposed');
});
