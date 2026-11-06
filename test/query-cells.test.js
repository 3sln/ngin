import { test, expect, mock, spyOn } from 'bun:test';
import { Engine, Query, QueryStore, PENDING } from '../index.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('query returns a stable Cell and reads stay lazy until the first listener', async () => {
  const store = new QueryStore();
  const boot = mock();
  const kill = mock();
  const query = new (class extends Query { boot = boot; kill = kill; })();
  const cell = store.query(query);
  expect(store.query(query)).toBe(cell);
  expect(cell.getValue()).toBe(PENDING);
  expect(cell.getValue()).toBe(PENDING);
  await tick();
  expect(boot).not.toHaveBeenCalled();
  const stop = cell.onDirty(() => {});
  await tick();
  expect(boot).toHaveBeenCalledTimes(1);
  stop();
  stop();
  await tick();
  expect(kill).toHaveBeenCalledTimes(1);
  await store.dispose();
});

test('duplicate Cell listeners own independent registrations and share one boot', async () => {
  const store = new QueryStore();
  let emit;
  const kill = mock();
  const query = new (class extends Query {
    boot(_, { notify }) { emit = notify; }
    kill = kill;
  })();
  const cell = store.query(query);
  const listener = mock();
  const one = cell.onDirty(listener);
  const two = cell.onDirty(listener);
  await tick();
  emit(undefined);
  expect(cell.getValue()).toBeUndefined();
  expect(listener.mock.calls).toEqual([[], []]);
  one();
  emit(2);
  expect(listener).toHaveBeenCalledTimes(3);
  expect(cell.getValue()).toBe(2);
  expect(kill).not.toHaveBeenCalled();
  two();
  await tick();
  expect(kill).toHaveBeenCalledTimes(1);
  expect(cell.getValue()).toBe(2);
  await store.dispose();
});

test('one-shot Cell retains its result and refetches when listeners reconnect', async () => {
  const store = new QueryStore();
  let fetched = 0;
  const cell = store.query(new (class extends Query { fetch() { return ++fetched; } })());
  const one = cell.onDirty(() => {});
  await tick();
  expect(cell.getValue()).toBe(1);
  one();
  const two = cell.onDirty(() => {});
  expect(cell.getValue()).toBe(PENDING);
  await tick();
  expect(cell.getValue()).toBe(2);
  two();
  await store.dispose();
});

test('Cell errors throw from reads and retry clears the failure', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const store = new QueryStore();
    const failure = new Error('failed');
    let fails = true;
    const cell = store.query(new (class extends Query {
      fetch() { if (fails) throw failure; return 'recovered'; }
    })());
    const changed = mock();
    const first = cell.onDirty(changed);
    await tick();
    expect(() => cell.getValue()).toThrow(failure);
    expect(changed).toHaveBeenCalledTimes(1);
    first();
    fails = false;
    const second = cell.onDirty(changed);
    expect(cell.getValue()).toBe(PENDING);
    await tick();
    expect(cell.getValue()).toBe('recovered');
    second();
    await store.dispose();
  } finally { errors.mockRestore(); }
});

test('a throwing dirty listener does not prevent peer invalidations', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const store = new QueryStore();
    const cell = store.query(new (class extends Query { fetch() { return 1; } })());
    const peer = mock();
    const first = cell.onDirty(() => { throw new Error('listener failed'); });
    const second = cell.onDirty(peer);
    await tick();
    expect(peer).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
    first(); second();
    await store.dispose();
  } finally { errors.mockRestore(); }
});

test('engine pending configuration reaches query cells', async () => {
  const pending = Symbol('external.PENDING');
  const engine = new Engine({ pending });
  const cell = engine.query(new (class extends Query { boot() {} })());
  expect(cell.getValue()).toBe(pending);
  await engine.dispose();
  expect(() => cell.onDirty(() => {})).toThrow('disposed');
});
