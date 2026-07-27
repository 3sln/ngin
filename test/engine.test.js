import { test, expect, mock } from 'bun:test';
import { Engine, Container, Dispatcher, QueryStore, Provider, Action, Query } from '../src/index.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('engine exposes the layers it composed', () => {
  const engine = new Engine({ providers: { a: Provider.fromSingleton(1) } });

  expect(engine.container).toBeInstanceOf(Container);
  expect(engine.dispatcher).toBeInstanceOf(Dispatcher);
  expect(engine.queries).toBeInstanceOf(QueryStore);
  expect(engine.feed).toBe(engine.container.feed);
  expect(engine.dispatcher.container).toBe(engine.container);
  expect(engine.queries.container).toBe(engine.container);
});

test('engine accepts pre-built layers', async () => {
  const container = new Container({ providers: { a: Provider.fromSingleton('shared') } });
  const dispatcher = new Dispatcher({ container });
  const engine = new Engine({ container, dispatcher });

  expect(engine.container).toBe(container);
  expect(engine.dispatcher).toBe(dispatcher);

  let seen;
  const feed = engine.dispatch(
    new (class extends Action {
      static deps = ['a'];
      execute({ a }) {
        seen = a;
      }
    })()
  );
  await new Promise((resolve) => feed.addEventListener('complete', resolve, { once: true }));
  expect(seen).toBe('shared');
});

test('engine can be constructed with no configuration at all', async () => {
  const engine = new Engine();
  const feed = engine.dispatch(
    new (class extends Action {
      execute() {}
    })()
  );
  await new Promise((resolve) => feed.addEventListener('complete', resolve, { once: true }));
  await engine.dispose();
});

test('a query lifecycle action reaches the engine dispatcher', async () => {
  const executed = mock();
  const engine = new Engine();

  const query = new (class extends Query {
    bootAction = new (class extends Action {
      execute() {
        executed();
      }
    })();
    boot(_, { notify }) {
      notify('v');
    }
  })();

  engine.query(query).subscribe(() => {});
  await tick();

  expect(executed).toHaveBeenCalledTimes(1);
  await engine.dispose();
});

test('dispose is idempotent and runs queries before providers', async () => {
  const order = [];

  const engine = new Engine({
    providers: {
      thing: class extends Provider {
        async obtain() {
          return 'thing';
        }
        release() {
          order.push('release');
        }
        async dispose() {
          order.push('provider:dispose');
        }
      },
    },
  });

  const query = new (class extends Query {
    static deps = ['thing'];
    boot() {}
    kill() {
      order.push('query:kill');
    }
  })();

  engine.query(query).subscribe(() => {});
  await tick();

  await engine.dispose();
  await engine.dispose();

  expect(order).toEqual(['query:kill', 'release', 'provider:dispose']);
});

test('the legacy hooks.createQueryControllersMap option is still honoured', async () => {
  const created = mock(() => new Map());
  const engine = new Engine({ hooks: { createQueryControllersMap: created } });

  const query = new (class extends Query {
    boot(_, { notify }) {
      notify('v');
    }
  })();

  engine.query(query).subscribe(() => {});
  await tick();

  expect(created).toHaveBeenCalledTimes(1);
  await engine.dispose();
});
