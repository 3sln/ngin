import { test, expect } from 'bun:test';
import { Container, Provider } from '../src/providers.js';

/** A resource that counts how many were built and destroyed. */
function counted({ create = async () => ({}) } = {}) {
  const state = { made: 0, destroyed: 0 };
  const P = Provider.fromLazySingleton(
    async (deps) => {
      state.made++;
      return create(deps);
    },
    () => { state.destroyed++; },
  );
  return { state, P };
}

test('nothing is built until something asks', async () => {
  const { state, P } = counted();
  const provider = new P({});
  expect(state.made).toBe(0);
  await provider.obtain();
  expect(state.made).toBe(1);
});

test('every consumer gets the same instance, at the same time', async () => {
  // The difference from fromPool(size: 1), which is a mutex: there, the second
  // obtain would not settle until the first released.
  const { state, P } = counted();
  const provider = new P({});
  const [a, b] = await Promise.all([provider.obtain(), provider.obtain()]);
  expect(a).toBe(b);
  expect(state.made).toBe(1);
});

test('a slow build is not raced into two resources', async () => {
  // The gate is set up before anything obtains, so this does not depend on when
  // `create` happens to be scheduled.
  const gate = Promise.withResolvers();
  const { state, P } = counted({ create: () => gate.promise });
  const provider = new P({});
  const first = provider.obtain();
  const second = provider.obtain();
  gate.resolve({});
  expect(await first).toBe(await second);
  expect(state.made).toBe(1);
});

test('releasing does not destroy it', async () => {
  // The difference from fromRefCounted: there, the count reaching zero tears the
  // resource down, and the next consumer silently gets a different one while
  // whatever held the old is still pointing at it.
  const { state, P } = counted();
  const provider = new P({});
  const first = await provider.obtain();
  provider.release(first);
  expect(state.destroyed).toBe(0);
  expect(await provider.obtain()).toBe(first);
  expect(state.made).toBe(1);
});

test('release is synchronous, so a hot path pays nothing for it', () => {
  // Consumers lease the backbone per request; `fromRefCounted.release` is async
  // and awaits teardown, which would put that on every request's way out.
  const { P } = counted();
  expect(new P({}).release({})).toBeUndefined();
});

test('dispose destroys it, once', async () => {
  const { state, P } = counted();
  const provider = new P({});
  await provider.obtain();
  await provider.dispose();
  await provider.dispose();
  expect(state.destroyed).toBe(1);
});

test('disposing something never built does not build it to destroy it', async () => {
  const { state, P } = counted();
  await new P({}).dispose();
  expect([state.made, state.destroyed]).toEqual([0, 0]);
});

test('dispose waits for a build still in flight rather than leaking it', async () => {
  const gate = Promise.withResolvers();
  const destroyed = [];
  const P = Provider.fromLazySingleton(
    () => gate.promise,
    (resource) => { destroyed.push(resource.id); },
  );
  const provider = new P({});
  provider.obtain().catch(() => {});
  const disposing = provider.dispose();
  gate.resolve({ id: 1 });
  await disposing;
  expect(destroyed).toEqual([1]);
});

test('obtaining after dispose fails rather than resurrecting it', async () => {
  const { P } = counted();
  const provider = new P({});
  await provider.obtain();
  await provider.dispose();
  expect(provider.obtain()).rejects.toThrow(/disposed/i);
});

test('a failed build is not cached, so the next caller gets a fresh attempt', async () => {
  let attempts = 0;
  const P = Provider.fromLazySingleton(async () => {
    attempts++;
    if (attempts === 1) throw new Error('the database was not up yet');
    return { ok: true };
  });
  const provider = new P({});
  await expect(provider.obtain()).rejects.toThrow('the database was not up yet');
  expect((await provider.obtain()).ok).toBe(true);
  expect(attempts).toBe(2);
});

test('dependencies arrive as providers, so the resource can hold them', async () => {
  // Same contract as the other factories: what is injected is the dependency
  // PROVIDER, because a resource built here usually outlives the call.
  const container = new Container({
    providers: {
      config: Provider.fromSingleton({ url: 'sqlite://drive.db' }),
      db: Provider.fromLazySingleton(
        async ({ config }) => ({ url: (await config.obtain()).url }),
        null,
        { deps: ['config'] },
      ),
    },
  });
  const db = await container.use(['db'], (r) => r.db);
  expect(db.url).toBe('sqlite://drive.db');
  await container.dispose();
});

test('the container disposes it in reverse construction order', async () => {
  // What makes teardown order fall out of the dependency graph: a resource is
  // always torn down before the things it was built from.
  const order = [];
  const container = new Container({
    providers: {
      db: Provider.fromLazySingleton(async () => ({}), () => order.push('db')),
      repo: Provider.fromLazySingleton(
        async ({ db }) => ({ db: await db.obtain() }),
        () => order.push('repo'),
        { deps: ['db'] },
      ),
    },
  });
  await container.use(['repo'], () => {});
  await container.dispose();
  expect(order).toEqual(['repo', 'db']);
});

test('a lease releases it without destroying it', async () => {
  // The whole point in context: an action leases the backbone, does its work,
  // and gives it back — and the drive is still there afterwards.
  const { state, P } = counted();
  const container = new Container({ providers: { db: P } });
  const first = await container.use(['db'], (r) => r.db);
  const second = await container.use(['db'], (r) => r.db);
  expect(first).toBe(second);
  expect(state.destroyed).toBe(0);
  await container.dispose();
  expect(state.destroyed).toBe(1);
});
