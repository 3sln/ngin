import { test, expect, mock } from 'bun:test';
import { Container, Provider } from '../src/providers.js';

test('container builds each provider exactly once across a diamond graph', () => {
  const built = [];

  class Leaf extends Provider {
    constructor() {
      super();
      built.push('leaf');
    }
  }
  class Left extends Provider {
    static deps = ['leaf'];
    constructor({ leaf }) {
      super();
      this.leaf = leaf;
      built.push('left');
    }
  }
  class Right extends Provider {
    static deps = ['leaf'];
    constructor({ leaf }) {
      super();
      this.leaf = leaf;
      built.push('right');
    }
  }
  class Top extends Provider {
    static deps = ['left', 'right'];
    constructor({ left, right }) {
      super();
      this.left = left;
      this.right = right;
      built.push('top');
    }
  }

  const container = new Container({
    providers: { top: Top, left: Left, right: Right, leaf: Leaf },
  });

  expect(built).toEqual(['leaf', 'left', 'right', 'top']);
  expect(container.get('left').leaf).toBe(container.get('leaf'));
  expect(container.get('right').leaf).toBe(container.get('leaf'));
  expect(container.get('top').left).toBe(container.get('left'));
});

test('container reports missing and cyclic dependencies', () => {
  class A extends Provider {
    static deps = ['b'];
  }
  class B extends Provider {
    static deps = ['a'];
  }

  expect(() => new Container({ providers: { a: A, b: B } })).toThrow(
    'Cyclic dependency detected: a -> b -> a'
  );

  class Orphan extends Provider {
    static deps = ['nope'];
  }
  expect(() => new Container({ providers: { orphan: Orphan } })).toThrow(
    'Dependency not found: nope'
  );

  const container = new Container({ providers: {} });
  expect(() => container.get('nope')).toThrow('Dependency not found: nope');
  expect(container.has('nope')).toBe(false);
});

test('resolve normalizes array and object deps and memoizes', () => {
  const container = new Container({
    providers: { a: Provider.fromSingleton(1), b: Provider.fromSingleton(2) },
  });

  const arrayConfig = ['a', 'b'];
  const resolved = container.resolve(arrayConfig);
  expect(Object.keys(resolved)).toEqual(['a', 'b']);
  expect(resolved.a.options).toBeUndefined();
  expect(container.resolve(arrayConfig)).toBe(resolved);

  const objectConfig = { a: { timeout: 5 } };
  expect(container.resolve(objectConfig).a.options).toEqual({ timeout: 5 });

  expect(container.resolve(undefined)).toEqual({});

  // Later declarations win.
  const merged = container.resolveAll(['a'], { a: { timeout: 9 } });
  expect(merged.a.options).toEqual({ timeout: 9 });
});

test('lease releases everything obtained when a later obtain fails', async () => {
  const releasedOk = mock();

  class Ok extends Provider {
    async obtain() {
      return 'ok';
    }
    release(resource) {
      releasedOk(resource);
    }
  }
  class Bad extends Provider {
    async obtain() {
      throw new Error('nope');
    }
  }

  const container = new Container({ providers: { ok: Ok, bad: Bad } });

  await expect(container.lease(['ok', 'bad'])).rejects.toThrow('nope');
  expect(releasedOk).toHaveBeenCalledTimes(1);
  expect(releasedOk).toHaveBeenLastCalledWith('ok');
});

test('lease release is idempotent and use() releases on throw', async () => {
  const release = mock();
  class P extends Provider {
    async obtain() {
      return 'r';
    }
    release(resource) {
      release(resource);
    }
  }
  const container = new Container({ providers: { p: P } });

  const lease = await container.lease(['p']);
  expect(lease.resources.p).toBe('r');
  await lease.release();
  await lease.release();
  expect(release).toHaveBeenCalledTimes(1);
  expect(lease.released).toBe(true);

  await expect(
    container.use(['p'], () => {
      throw new Error('boom');
    })
  ).rejects.toThrow('boom');
  expect(release).toHaveBeenCalledTimes(2);
});

test('container disposes dependents before their dependencies', async () => {
  const order = [];

  class Base extends Provider {
    async flush() {
      order.push('base:flush');
    }
    async dispose() {
      order.push('base:dispose');
    }
  }
  class Derived extends Provider {
    static deps = ['base'];
    async flush() {
      order.push('derived:flush');
    }
    async dispose() {
      order.push('derived:dispose');
    }
  }

  const container = new Container({ providers: { derived: Derived, base: Base } });
  await container.dispose();
  await container.dispose();

  expect(order).toEqual([
    'derived:flush',
    'base:flush',
    'derived:dispose',
    'base:dispose',
  ]);
  expect(container.disposed).toBe(true);
  await expect(container.lease(['base'])).rejects.toThrow('disposed');
});

test('singleton provider passes dep providers to dispose and disposes once', async () => {
  const dispose = mock();
  const container = new Container({
    providers: {
      config: Provider.fromSingleton({ url: 'x' }),
      thing: Provider.fromSingleton('resource', { dispose, deps: ['config'] }),
    },
  });

  const thing = container.get('thing');
  await thing.dispose();
  await thing.dispose();

  expect(dispose).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenLastCalledWith('resource', {
    config: container.get('config'),
  });
});

test('pool never exceeds its size under concurrent obtains', async () => {
  const create = mock(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return {};
  });
  const pool = new (Provider.fromPool(create, () => {}, { size: 1 }))();

  const first = pool.obtain();
  const second = pool.obtain();

  const r1 = await first;
  expect(create).toHaveBeenCalledTimes(1);

  pool.release(r1);
  expect(await second).toBe(r1);
  expect(create).toHaveBeenCalledTimes(1);
});

test('pool hands a failed create to the caller without stranding waiters', async () => {
  let n = 0;
  const create = mock(async () => {
    n++;
    if (n === 1) {
      throw new Error('create failed');
    }
    return { n };
  });
  const pool = new (Provider.fromPool(create, () => {}, { size: 1 }))();

  const first = pool.obtain();
  const second = pool.obtain();

  await expect(first).rejects.toThrow('create failed');
  expect(await second).toEqual({ n: 2 });
});

test('pool passes dependency providers to create and destroy', async () => {
  // A dependency reaches create/destroy as a provider, so the created resource
  // can hold it for its own lifetime instead of just reading it once.
  const create = mock(async ({ config }) => {
    const cfg = await config.obtain();
    return { url: cfg.url, config, cfg };
  });
  const destroy = mock((conn) => conn.config.release(conn.cfg));

  const container = new Container({
    providers: {
      config: Provider.fromSingleton({ url: 'db://x' }),
      conn: Provider.fromPool(create, destroy, { size: 1, deps: ['config'] }),
    },
  });

  const configProvider = container.get('config');
  const pool = container.get('conn');

  const conn = await pool.obtain();
  expect(conn.url).toBe('db://x');
  expect(create).toHaveBeenLastCalledWith({ config: configProvider });

  pool.release(conn);
  await pool.dispose();
  expect(destroy).toHaveBeenLastCalledWith(conn, { config: configProvider });
});

test('pool rejects obtains once disposed', async () => {
  const pool = new (Provider.fromPool(async () => ({}), () => {}))();
  await pool.dispose();
  await expect(pool.obtain()).rejects.toThrow('The provider has been disposed');
});

test('fromPool validates size', () => {
  expect(() => Provider.fromPool(() => {}, () => {}, { size: 0 })).toThrow(
    'at least 1'
  );
});

test('ref counted provider recovers from a failed create', async () => {
  let n = 0;
  const create = mock(async () => {
    n++;
    if (n === 1) {
      throw new Error('create failed');
    }
    return { n };
  });
  const provider = new (Provider.fromRefCounted(create, () => {}))();

  await expect(provider.obtain()).rejects.toThrow('create failed');
  expect(await provider.obtain()).toEqual({ n: 2 });
});

test('ref counted provider does not recreate on top of an in-flight destroy', async () => {
  let created = 0;
  const create = mock(async () => ({ id: ++created }));
  const destroy = mock(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  const provider = new (Provider.fromRefCounted(create, destroy))();

  const first = await provider.obtain();
  expect(first.id).toBe(1);

  const releasing = provider.release();
  const second = await provider.obtain();

  await releasing;

  expect(destroy).toHaveBeenCalledTimes(1);
  expect(destroy).toHaveBeenLastCalledWith(first, {});
  // The second obtain waited for the teardown and got a fresh resource.
  expect(second.id).toBe(2);

  await provider.release();
  expect(destroy).toHaveBeenCalledTimes(2);
  expect(destroy).toHaveBeenLastCalledWith(second, {});
});

test('a created resource can hold a dependency for its own lifetime', async () => {
  // This is the reason create/destroy get providers rather than resources: the
  // session has to stay obtained for as long as the client that uses it lives.
  const closeSession = mock();

  const container = new Container({
    providers: {
      session: Provider.fromRefCounted(async () => ({ id: 's1' }), closeSession),
      client: Provider.fromRefCounted(
        async ({ session }) => ({ session, handle: await session.obtain() }),
        async (client) => await client.session.release(client.handle),
        { deps: ['session'] }
      ),
    },
  });

  const client = container.get('client');
  const resource = await client.obtain();
  expect(resource.handle.id).toBe('s1');

  // The session is still held while the client is alive.
  expect(closeSession).not.toHaveBeenCalled();

  await client.release();
  expect(closeSession).toHaveBeenCalledTimes(1);
});

test('ref counted release below zero is a no-op', async () => {
  const destroy = mock();
  const provider = new (Provider.fromRefCounted(async () => ({}), destroy))();

  await provider.release();
  await provider.release();
  expect(destroy).not.toHaveBeenCalled();
});

test('base provider obtain is unimplemented', async () => {
  await expect(new Provider().obtain()).rejects.toThrow('obtain() not implemented');
});
