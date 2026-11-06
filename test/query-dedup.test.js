import { test, expect } from 'bun:test';
import { Query, QueryStore } from '../src/queries.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class KeyedQuery extends Query {
  constructor(key, value = key) {
    super();
    this.key = key;
    this.value = value;
    this.boots = 0;
    this.kills = 0;
  }
  dedupKey() { return this.key; }
  boot(_, { notify }) { this.boots++; notify(this.value); }
  kill() { this.kills++; }
}

test('explicit dedup keys share the first active instance until the final unsubscribe', async () => {
  const store = new QueryStore();
  const first = new KeyedQuery('a', 'first');
  const second = new KeyedQuery('a', 'second');
  const values = [];
  const one = store.query(first).subscribe(() => {});
  const two = store.query(second).subscribe((value) => values.push(value));
  await tick();
  expect(values).toEqual(['first']);
  expect(first.boots).toBe(1);
  expect(second.boots).toBe(0);
  expect(await store.query(second).peek()).toBe('first');
  one.unsubscribe();
  await tick();
  expect(first.kills).toBe(0);
  two.unsubscribe();
  const three = store.query(second).subscribe((value) => values.push(value));
  await tick();
  expect(first.kills).toBe(1);
  expect(second.boots).toBe(1);
  expect(values).toEqual(['first', 'second']);
  three.unsubscribe();
  await store.dispose();
});

test('dedup keys are constructor scoped and undefined is a valid key', async () => {
  const store = new QueryStore();
  class OtherQuery extends KeyedQuery {}
  const first = new KeyedQuery(undefined, 'first');
  const second = new KeyedQuery(undefined, 'second');
  const other = new OtherQuery(undefined, 'other');
  const values = [];
  store.query(first).subscribe((value) => values.push(value));
  store.query(second).subscribe((value) => values.push(value));
  store.query(other).subscribe((value) => values.push(value));
  await tick();
  expect(values).toEqual(['first', 'first', 'other']);
  expect(second.boots).toBe(0);
  expect(other.boots).toBe(1);
  await store.dispose();
});

test('queries without a dedup hook keep instance identity', async () => {
  const store = new QueryStore();
  class IdentityQuery extends Query {
    boot(_, { notify }) { notify(this); }
  }
  const first = new IdentityQuery();
  const second = new IdentityQuery();
  const values = [];
  store.query(first).subscribe((value) => values.push(value));
  store.query(second).subscribe((value) => values.push(value));
  await tick();
  expect(values).toEqual([first, second]);
  await store.dispose();
});

test('one-shot dedup keys are removed after completion so the next instance fetches', async () => {
  const store = new QueryStore();
  class Read extends Query {
    constructor(value) { super(); this.value = value; }
    dedupKey() { return 'same'; }
    fetch() { return this.value; }
  }
  const values = [];
  store.query(new Read(1)).subscribe((value) => values.push(value));
  await tick();
  store.query(new Read(2)).subscribe((value) => values.push(value));
  await tick();
  expect(values).toEqual([1, 2]);
  await store.dispose();
});

test('custom equality shares structurally equal arguments without a key', async () => {
  const store = new QueryStore();
  class StructuralQuery extends Query {
    constructor(filter) { super(); this.filter = filter; this.boots = 0; }
    dedupEquiv(other) { return this.filter.id === other.filter.id; }
    boot(_, { notify }) { this.boots++; notify(this.filter); }
  }
  const first = new StructuralQuery({ id: 1 });
  const equal = new StructuralQuery({ id: 1 });
  const different = new StructuralQuery({ id: 2 });
  const values = [];
  store.query(first).subscribe((value) => values.push(value));
  store.query(equal).subscribe((value) => values.push(value));
  store.query(different).subscribe((value) => values.push(value));
  await tick();
  expect(values).toEqual([{ id: 1 }, { id: 1 }, { id: 2 }]);
  expect(equal.boots).toBe(0);
  expect(different.boots).toBe(1);
  expect(await store.query(equal).peek()).toBe(first.filter);
  await store.dispose();
});

test('key collisions compare equality and removing one entry preserves its peers', async () => {
  const store = new QueryStore();
  class ShardedQuery extends KeyedQuery {
    dedupKey() { return 'collision'; }
    dedupEquiv(other) { return this.key.id === other.key.id; }
  }
  const first = new ShardedQuery({ id: 1 }, 'first');
  const different = new ShardedQuery({ id: 2 }, 'different');
  const equal = new ShardedQuery({ id: 1 }, 'equal');
  const values = [];
  const one = store.query(first).subscribe((value) => values.push(value));
  store.query(different).subscribe((value) => values.push(value));
  const two = store.query(equal).subscribe((value) => values.push(value));
  await tick();
  expect(values).toEqual(['first', 'first', 'different']);
  expect(different.boots).toBe(1);
  expect(equal.boots).toBe(0);
  one.unsubscribe();
  two.unsubscribe();
  const replacement = new ShardedQuery({ id: 1 }, 'replacement');
  store.query(replacement).subscribe((value) => values.push(value));
  expect(await store.query(new ShardedQuery({ id: 2 })).peek()).toBe('different');
  await tick();
  expect(replacement.boots).toBe(1);
  expect(values).toEqual(['first', 'first', 'different', 'replacement']);
  await store.dispose();
});

test('optional keys restrict equality comparisons to the matching shard', async () => {
  const store = new QueryStore();
  const compared = [];
  class ShardedQuery extends KeyedQuery {
    dedupKey() { return this.key.region; }
    dedupEquiv(other) {
      compared.push([this.key.region, other.key.region]);
      return this.key.id === other.key.id;
    }
  }
  store.query(new ShardedQuery({ region: 'a', id: 1 })).subscribe(() => {});
  store.query(new ShardedQuery({ region: 'b', id: 2 })).subscribe(() => {});
  store.query(new ShardedQuery({ region: 'a', id: 1 })).subscribe(() => {});
  await tick();
  expect(compared).toEqual([['a', 'a']]);
  await store.dispose();
});

test('instance-level comparators are respected whichever instance subscribes first', async () => {
  for (const comparatorFirst of [false, true]) {
    const store = new QueryStore();
    const plain = new KeyedQuery('bucket', 'plain');
    const custom = new KeyedQuery('bucket', 'custom');
    custom.dedupEquiv = (other) => custom.value === other.value;
    const [first, second] = comparatorFirst ? [custom, plain] : [plain, custom];
    store.query(first).subscribe(() => {});
    store.query(second).subscribe(() => {});
    await tick();
    expect(first.boots).toBe(1);
    expect(second.boots).toBe(1);
    await store.dispose();
  }
});
