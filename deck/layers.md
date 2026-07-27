# Layers

`ngin` is three independent layers stacked on one another. Each has its own
entry point, and each one only knows about the layer below it, so you can stop
wherever your application stops.

| Layer | Entry point | Exports | Depends on |
| --- | --- | --- | --- |
| Dependency injection | `@3sln/ngin/providers` | `Provider`, `Container` | — |
| Actions | `@3sln/ngin/actions` | `Action`, `Dispatcher` | providers |
| Queries | `@3sln/ngin/queries` | `Query`, `QueryStore` | providers |
| Everything | `@3sln/ngin` | all of the above, plus `Engine` | — |

Actions and queries are siblings: neither imports the other. A `QueryStore`
only reaches the actions layer when a query declares a `bootAction` or
`killAction`, and it gets there through a `dispatch` method you hand it — not
through an import.

## Just dependency injection

```javascript
import { Container, Provider } from '@3sln/ngin/providers';

const container = new Container({
  providers: {
    config: Provider.fromSingleton({ apiUrl: 'https://api.example.com' }),
    api: Provider.fromRefCounted(
      async ({ config }) => {
        const cfg = await config.obtain();
        try {
          return new ApiClient(cfg.apiUrl);
        } finally {
          config.release(cfg);
        }
      },
      (api) => api.close(),
      { deps: ['config'] }
    ),
  },
});

// Scoped: obtain, run, release.
const users = await container.use(['api'], ({ api }) => api.getUsers());

await container.dispose();
```

## Dependency injection plus actions

```javascript
import { Container, Provider } from '@3sln/ngin/providers';
import { Action, Dispatcher } from '@3sln/ngin/actions';

const container = new Container({ providers: { api: ApiProvider } });
const dispatcher = new Dispatcher({
  container,
  interceptors: [loggingInterceptor],
});

class SyncAction extends Action {
  static deps = ['api'];
  async execute({ api }) {
    await api.sync();
  }
}

dispatcher.dispatch(new SyncAction());
```

No query machinery is loaded, and nothing in your bundle references it.

## Dependency injection plus queries

```javascript
import { Container } from '@3sln/ngin/providers';
import { Query, QueryStore } from '@3sln/ngin/queries';

const container = new Container({ providers: { clock: ClockProvider } });
const queries = new QueryStore({ container });

queries.query(new CurrentTimeQuery()).subscribe(console.log);
```

A `QueryStore` built without a `dispatcher` is fully functional; it only
complains if a query you realize declares a `bootAction` or `killAction`.

## All three

`Engine` is a facade that builds all three layers and wires them together. It
is the only thing that knows about all of them at once.

```javascript
import { Engine } from '@3sln/ngin';

const engine = new Engine({ providers, interceptors });
```

That is equivalent to:

```javascript
const container = new Container({ providers });
const dispatcher = new Dispatcher({ container, interceptors });
const queries = new QueryStore({ container, dispatcher });
```

You can also hand `Engine` layers you built yourself, which is how you share a
container between two engines or swap in a stub for tests:

```javascript
const engine = new Engine({ container, dispatcher });
```

And you can reach the layers back out of an engine:

```javascript
engine.container;   // Container
engine.dispatcher;  // Dispatcher
engine.queries;     // QueryStore
```

## The seam between layers

Everything above the provider layer talks to it through four members, and
nothing else:

*   **`feed`** — the shared `EventTarget`.
*   **`resolve(depsConfig)`** — turns `['a']` or `{ a: options }` into
    `{ a: { provider, options } }`.
*   **`lease(...depsConfigs)`** — obtains every declared resource, returning
    `{ resources, release() }`. If one `obtain` fails, the ones already
    obtained are released before the error propagates. `release()` is
    idempotent.
*   **`use(depsConfig, fn)`** — a scoped lease: obtain, run `fn`, release, even
    if `fn` throws.

Anything implementing those four can stand in for a `Container`. A lease is
also the reason the two upper layers can share one resource model despite
having very different lifetimes: an action holds a lease for a single dispatch,
a query holds one from `boot` until `kill`.
