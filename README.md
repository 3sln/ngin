# ngin

> [!WARNING]
> This is a work-in-progress project and is not yet ready for production use.

`ngin` is a lightweight and flexible state management library designed to help
you organize your frontend application logic. It uses a dependency injection
model to coordinate resources, actions, and queries, keeping your code clean
and testable.

It is built as three independent layers, so you can take only what you need:

| Layer | Import | Exports | Depends on |
| --- | --- | --- | --- |
| Dependency injection | `@3sln/ngin/providers` | `Provider`, `Container` | — |
| Actions | `@3sln/ngin/actions` | `Action`, `Dispatcher`, `DispatchFeed` | providers |
| Queries | `@3sln/ngin/queries` | `Query`, `QueryStore`, `PENDING` | providers |
| Everything | `@3sln/ngin` | all of the above, plus `Engine` | — |

Actions and queries are siblings: neither imports the other. See
[Layered Usage](#layered-usage).

## Quick Start

```javascript
import { Engine, Action, Query, Provider, PENDING } from '@3sln/ngin';

// Set up a LoggerProvider. It's a dependency for other stuff.
class LoggerProvider extends Provider {
  obtain() {
    // This is the actual resource.
    return {
      log: (message) => console.log(`[LOG]: ${message}`)
    };
  }
  release() {}
}

// Next, a DataProvider that needs the logger. Providers get other providers
// injected, so they can handle their dependencies' lifecycles.
class DataProvider extends Provider {
  static deps = ['logger'];
  
  constructor({ logger }) {
    super();
    this.loggerProvider = logger;
  }
  
  async obtain() {
    const logger = await this.loggerProvider.obtain();
    logger.log('Data connection created.');
    this.loggerProvider.release(logger);
    // The resource is an object with a fetchData method.
    return {
      fetchData: () => 'some data'
    };
  }
  
  async release() {
    const logger = await this.loggerProvider.obtain();
    logger.log('Data connection destroyed.');
    this.loggerProvider.release(logger);
  }
}

// An interceptor that uses the logger. Interceptors, actions, and queries
// all get the actual resource injected.
//
// One interceptor wraps both: the context carries `action` for a dispatch and
// `query` for a query, so a hook can tell them apart when it cares.
const loggerInterceptor = {
  deps: ['logger'],
  enter: ({ logger }, { action, query }) => {
    logger.log(`Entering: ${(action ?? query).constructor.name}`);
  },
  leave: ({ logger }, { action, query }) => {
    logger.log(`Leaving: ${(action ?? query).constructor.name}`);
  },
};

// An Action that depends on the Data Provider.
class MyAction extends Action {
  static deps = ['data'];
  async execute({ data }) {
    console.log(`Executing action with: ${data.fetchData()}`);
  }
}

// A Query that also depends on the Data Provider.
class MyQuery extends Query {
  static deps = ['data'];
  // Queries are booted on the first subscriber.
  async boot({ data }, { notify }) {
    notify(data.fetchData());
  }
  // Queries are killed when the last subscriber unsubscribes.
  async kill({ data }) {
    console.log(`Query killed with data: ${data.fetchData()}`);
  }
}

// Instantiate the engine and kick off the examples.
const engine = new Engine({
  providers: {
    logger: LoggerProvider,
    data: DataProvider,
  },
  interceptors: [loggerInterceptor],
});

console.log('--- Dispatching Action ---');
const actionFeed = engine.dispatch(new MyAction());
// The dispatch feed is an EventTarget, and `next` awaits one of its events.
await actionFeed.next('complete');

console.log('--- Query Lifecycle ---');
// Queries expose Cells: subscribe to invalidation, then pull the latest value.
const queryCell = engine.query(new MyQuery());
const renderQuery = () => {
  const value = queryCell.getValue();
  if (value !== PENDING) console.log(`Query received value: ${value}`);
};
const stop = queryCell.onDirty(renderQuery);
renderQuery();

setTimeout(stop, 100);

await engine.dispose();
```

-----

## Layered Usage

`Engine` is a facade. It builds a `Container`, a `Dispatcher` and a
`QueryStore` and wires them together — nothing more. When you only need part of
that, build the part you need.

### Just dependency injection

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

// Scoped: obtain, run, release — even if the callback throws.
const users = await container.use(['api'], ({ api }) => api.getUsers());

// Or hold a lease for work that outlives a single call.
const lease = await container.lease(['api']);
lease.resources.api.subscribe(/* ... */);
await lease.release();

await container.dispose();
```

### Dependency injection plus actions

```javascript
import { Container } from '@3sln/ngin/providers';
import { Action, Dispatcher } from '@3sln/ngin/actions';

const dispatcher = new Dispatcher({
  container: new Container({ providers }),
  interceptors: [loggerInterceptor],
});

dispatcher.dispatch(new MyAction());
```

### Dependency injection plus queries

```javascript
import { Container } from '@3sln/ngin/providers';
import { QueryStore, PENDING } from '@3sln/ngin/queries';

const queries = new QueryStore({
  container: new Container({ providers }),
  interceptors: [loggerInterceptor],
});

const result = queries.query(new MyQuery());
const read = () => {
  const value = result.getValue();
  if (value !== PENDING) console.log(value);
};
const stop = result.onDirty(read);
read();
// Call stop() when the consumer goes away.
```

A `QueryStore` built without a `dispatcher` works fine; it only needs one if a
query you realize declares a `bootAction` or `killAction`.

#### Query Cells

`engine.query(instance)` and `queries.query(instance)` return a Cell with two
methods: `onDirty(listener)` registers an invalidation callback and returns an
idempotent unsubscribe function; `getValue()` synchronously reads the current
value. A dirty callback receives no arguments: pull the value when you need it,
so consumers can coalesce several invalidations into one read.

The first dirty listener boots the query, and the last unsubscribe kills it.
Legacy subscribers count toward the same lifetime. `getValue()` never starts a
query, leases resources, or calls `fetch()`. Before a value arrives it returns
the exported `PENDING` symbol; an emitted `undefined` is an ordinary value.
Failures notify listeners and throw from `getValue()`. Catch errors at the
consumer's read boundary. Disconnected Cells retain their last observed value
or failure. Reconnecting after the realization ends starts with pending state
and retries the query; an already active realization supplies its current state.

Repeated calls with the same query instance return the same Cell. A Cell can
also read an equivalent query's active value through the dedup hooks below.

Cells compose directly with dodo's reactive helpers. Because dodo uses its own
pending symbol, configure that exact sentinel when constructing the engine or
store. ngin has no dependency on dodo:

```js
import { Engine } from '@3sln/ngin';
import { PENDING, derive, effect } from '@3sln/dodo/reactive';

const engine = new Engine({ providers, pending: PENDING });
const items = engine.query(new ReadItems('photos'));
const count = derive([items], (values) => values.length);
const stop = effect(count, (value) => console.log(`${value} items`));
// count also works as the source for dodo's watch(count, renderCount).
```

`new QueryStore({ pending: PENDING })` supports the same configuration. When
supplying a prebuilt store to `Engine`, configure the sentinel on that store.

The previous `subscribe(observerOrNext)` and asynchronous `peek()` methods
remain on the Cell for backward compatibility and are deprecated. Legacy
`subscribe` preserves `next`, `error`, `complete`, and `{unsubscribe, closed}`;
`peek()` still waits for an active query's first value or calls `fetch()` when
inactive. Their behavior is unchanged; migrate reactive consumers to
`onDirty`/`getValue` as convenient.

#### Sharing equivalent query instances

By default, subscriptions share a live query only when they use the same query
instance. Implement `dedupEquiv(otherQuery)` to share equivalent instances of the
same query class, including queries whose arguments are distinct objects:

```js
class UserQuery extends Query {
  constructor(filter) {
    super();
    this.filter = filter;
  }

  dedupEquiv(other) {
    return this.filter.teamId === other.filter.teamId &&
      this.filter.userId === other.filter.userId;
  }

  // Optional: only compare candidates in the same team bucket.
  dedupKey() { return this.filter.teamId; }

  // boot(), kill(), and dependencies as usual
}
```

Without `dedupKey()`, equality checks scan active realizations of the same query
constructor. An optional `dedupKey()` narrows that search to a bucket, using
JavaScript `Map` equality for the bucket keys. Colliding keys still use `dedupEquiv`
to decide sharing. Equal queries must return the same bucket key; use a stable
primitive key or a shared object identity. `undefined` is a valid key.

The comparator must be a synchronous, pure equivalence relation (reflexive,
symmetric, and transitive). Keep equality arguments and keys stable while the
query is active. The active instance's comparator is called with the incoming
query; if only the incoming instance has a comparator, that comparator is used
instead. A `dedupKey()` without `dedupEquiv()` is a convenience for sharing directly
by key using `Map` equality.

The first active instance supplies the implementation and dependencies; other
equivalent instances receive its values, including through `peek()`. The final
unsubscribe or query completion removes that realization and its dedup entry,
so the next subscription starts fresh. Separate query classes never share a
realization merely because their keys or arguments match.

#### One-shot queries

A query that implements `fetch` and not `boot` is a **read**: it has one answer
and no way of learning of a second. Its first Cell listener starts one fetch.
The Cell retains the result after the query releases its resources. Removing
all listeners and reconnecting fetches again.

```javascript
class ReadItems extends Query {
  static deps = ['db'];
  constructor(collection) { super(); this.collection = collection; }
  async fetch({ db }) { return db.list(this.collection); }
}

const items = engine.query(new ReadItems('photos'));
const renderItems = () => {
  const value = items.getValue();
  if (value !== PENDING) render(value);
};
const stop = items.onDirty(renderItems);
renderItems();
```

Concurrent consumers share one fetch. Completion evicts the realization so a
later connection can refresh, while existing Cells keep the result. A failed
fetch throws from the Cell's `getValue()` and can be retried by disconnecting
all its listeners and reconnecting. Legacy subscribers still receive one
`next` followed by `complete`, or `error` when the fetch fails.

### Composing them yourself

`Engine` accepts pre-built layers, which is how you share a container between
engines or substitute a stub in tests. It also hands them back:

```javascript
const container = new Container({ providers });
const engine = new Engine({ container, interceptors });

engine.container;   // the Container above
engine.dispatcher;  // Dispatcher
engine.queries;     // QueryStore
```

### The seam

Everything above the provider layer talks to it through four members and
nothing else — `feed`, `resolve(depsConfig)`, `lease(...depsConfigs)` and
`use(depsConfig, fn)` — so anything implementing those can stand in for a
`Container`.

A **lease** is what lets the two upper layers share one resource model despite
very different lifetimes: an action holds a lease for a single dispatch, a
query holds one from `boot` until `kill`. `lease()` obtains every declared
resource or none of them, and its `release()` is idempotent.

-----

## The Dispatch Feed

`dispatch()` returns a `DispatchFeed`. It is an `EventTarget`, and it is the
only way results leave an action — deliberately, because an action that emits
`progress` five times before it emits `result` is saying more than a return
value could.

```javascript
class ScanCollection extends Action {
  static deps = ['storage'];
  async execute({ storage }, { dispatchFeed, signal }) {
    for await (const page of storage.pages()) {
      if (signal.aborted) return;         // cooperative — see abort() below
      dispatchFeed.dispatchEvent(
        Object.assign(new Event('progress'), { scanned: page.seen })
      );
    }
    dispatchFeed.dispatchEvent(
      Object.assign(new Event('result'), { ok: true })
    );
  }
}
```

A dispatch ends on exactly one of **`complete`**, **`error`** or **`abort`**,
once.

### `feed.next(names, { signal })`

Awaits the first of `names` to fire and resolves with that event — the shape a
request handler wants: dispatch, await the event carrying the answer, reply.

```javascript
const feed = engine.dispatch(new ScanCollection());
feed.addEventListener('progress', (e) => console.log(e.scanned));

const result = await feed.next('result');     // or feed.next(['hit', 'miss'])
```

All three terminal events end the wait unless you name one, because after one of
them nothing else will ever fire:

- the action **throws** → rejects with the error the action threw, unwrapped, so
  a caller mapping error types onto something else (an HTTP status, say) still
  can;
- the dispatch is **aborted** → rejects with the abort reason;
- it **ends without emitting** what you asked for → rejects saying so. A promise
  that never settles is the worst thing this could do to a caller — no timeout,
  no cancellation, nothing to log — so it never does;
- naming `'complete'`, `'error'` or `'abort'` opts back in to receiving it as a
  value.

`next` also answers correctly after the fact. Terminal events fire exactly once,
so a caller that awaits something else first would otherwise be waiting on an
event already gone past; the feed remembers how it ended, and `feed.settled`
reports it (`'complete'`, `'error'`, `'abort'`, or `null` while running).

The optional `signal` is the **caller's own** cancellation, distinct from
`feed.abort()`. An HTTP handler passes the request's signal so a disconnect
unblocks the handler while work already underway carries on.

### `feed.abort(reason)` and `context.signal`

`abort()` says the caller is no longer interested. The signal is handed to the
action and to every interceptor as `context.signal`:

```javascript
const feed = engine.dispatch(new ScanCollection());
feed.abort(new Error('client disconnected'));
const ended = await feed.next('abort');       // ended.reason === that error
```

Cooperative, necessarily: nothing can interrupt a running function, so an action
that wants to be stoppable checks `signal.aborted`, or hands the signal to
something that honours it (`fetch`, a scan loop, a nested dispatch).

`feed.reason` is what `abort()` was given — an `AbortError` if it was given
nothing, never `undefined`, since that value is what `next()` rejects with and a
caller writing `catch (e) { e.message }` should not have to guard it. The feed
keeps its own copy rather than reading `signal.reason` back at the point of use;
that one belongs to the runtime, and Bun 1.3 drops it under memory pressure.

**An aborted dispatch ends on `abort` and never on `complete`.** A scan stopped
at thirty percent did not complete, and saying it did is how "it worked" gets
reported about work that did not happen. That holds however the action ended: one
that throws because it honoured the signal threw *because* of the abort, so
reporting the throw would name the symptom rather than the cause. The error rides
along on the event as `event.error`, so nothing is lost.

Three details worth knowing:

- **Anything waiting on `next()` rejects at once**, except a wait for `abort`
  itself. The action may take a while to notice; the caller does not have to
  wait for it. Awaiting `abort` after aborting is the ordinary wind-down — you
  have stopped caring about the answer but still need to know the work stopped.
- **Aborting something already finished changes nothing.** What happened,
  happened; a late `abort()` does not rewrite a `complete` into an `abort`.
- **Aborting before the action starts is a real ordering**, since `dispatch()`
  returns synchronously and the action runs on a later turn. The action still
  runs, and sees `signal.aborted === true` immediately — skipping it would skip
  the interceptor unwinding with it, and an interceptor that opened something has
  to be given the chance to close it.

### The `abort` interceptor hook

Interceptors unwind through `leave` on success and `error` on failure. An
aborted dispatch gets a third: `abort`. It matters because of what `leave` means
to the obvious interceptor —

```javascript
const transaction = {
  deps: ['db'],
  enter: ({ db }) => db.begin(),
  leave: ({ db }) => db.commit(),
  error: ({ db }) => db.rollback(),
  abort: ({ db }) => db.rollback(),   // without this, `leave` commits
};
```

— which without an `abort` hook **commits the work of a dispatch that was
cancelled half way through**, since `error` is null and `leave` is what runs.

The hook receives `reason` (what `abort()` was given) and `error` (what the
action threw on its way out, usually because it honoured the signal; `null`
otherwise). There is no `handled()`: a cancellation cannot be handled into a
success, because the work did not happen.

Every interceptor that entered gets exactly **one** unwind call — that is what
makes it safe to acquire something in `enter` — so `abort` falls back to the
hook that would have run without it, never to nothing:

```
aborted   → abort ?? (error ? error : leave)
error     → error ?? nothing
otherwise → leave ?? nothing
```

An interceptor that has not heard of aborting therefore behaves exactly as it
does today; defining `abort` is how you opt into the distinction.

-----

## Interceptors Wrap Queries Too

An interceptor wraps *work*, and a query is work. The same list covers both
layers, so a concern that belongs to your application rather than to one kind
of call — an access check, a metric, a usage record, a log — is registered once:

```javascript
const engine = new Engine({ providers, interceptors: [usage] });
// or, by hand:
const dispatcher = new Dispatcher({ container, interceptors: [usage] });
const queries = new QueryStore({ container, dispatcher, interceptors: [usage] });
```

### Which one am I wrapping?

The context says so by name. `action` is there for a dispatch, `query` for a
query, and never both:

| Key | Present for | Alongside |
| --- | --- | --- |
| `action` | a dispatch | `dispatchFeed`, `signal` |
| `query` | a query | `bootFeed`, `killFeed` |

`engineFeed` and `state` are on both, and `state` reaches the work itself: an
action's `execute`, a query's `boot`, `fetch` and `kill` all receive what the
`enter` hooks threaded through.

```javascript
const usage = {
  deps: ['metrics'],
  enter: ({ metrics }, { action, query }) => {
    metrics.increment(action ? 'action' : 'query', (action ?? query).constructor.name);
  },
};
```

### Enter on boot, leave on tear down

A live query is entered **before it boots** — before its `bootAction` is
dispatched and before its resources are leased, so an access check can refuse it
before anything happens on its behalf — and left once the last observer has
unsubscribed, the query has been killed and its lease released. `enter` and
`leave` can therefore be minutes apart, which is exactly what makes them useful
for a permit, a span, or a subscription count.

A query answered by `fetch` is the shape a dispatch is:

```
subscribe to a live query   enter, boot ... kill, leave
subscribe to a one-shot     enter, fetch, leave
peek() an inactive query    enter, fetch, leave
peek() an active query      nothing — it was entered when it booted
```

Two consequences, which matter most to anything counting:

- **A query is entered once per realization, not once per subscriber.** The
  second observer of a query that is already running joins the live one; there
  is no second `enter`, and `leave` runs when the *last* of them unsubscribes.
- **A `bootAction` or `killAction` is a dispatch in its own right**, so it runs
  the stack again with `action` set, nested inside the query's.

The `abort` hook is a dispatch's alone: a query has no caller to give up on it,
so it ends through `leave` or `error` and never through `abort`.

### They have no say in the result

Values reaching your subscribers, and the value `peek()` resolves with, are the
query's own whatever the hooks return. A hook's return value goes to `state`
and nowhere else.

Failure works as it does for a dispatch — `error` hooks in reverse order, one
unwind call per interceptor that entered — with one difference worth stating:
`handled()` cannot bring a query back. By the time the stack unwinds, a query
that failed has already told its observers and released its lease, so handling
its error only means the interceptors outside see a query that ended rather than
one that broke. A query that fails to boot is unwound there and then, so being
killed afterwards does not unwind it twice.

-----

## Provider Options
You can configure dependencies for actions, interceptors, or queries with an
options object. This object is passed as the first argument to the provider's
`obtain` method.

For these components, you can specify dependencies using an object instead of
an array. The values of this object are the options passed to the corresponding
provider.

```javascript
class MyProviderWithOptions extends Provider {
  obtain(options) {
    // options will be { timeout: 5000 }
    return { timeout: options.timeout };
  }
}

// In an action, you can declare a dependency with options.
class MyActionWithOptions extends Action {
  static deps = {
    myProvider: { timeout: 5000 }
  };
  async execute({ myProvider }) {
    console.log(`Provider configured with timeout: ${myProvider.timeout}`);
  }
}

const engine = new Engine({
  providers: {
    myProvider: MyProviderWithOptions,
  }
});

engine.dispatch(new MyActionWithOptions());
```

-----

## Provider Lifecycle: `obtain`, `release`, `flush`, and `dispose`
Providers manage the lifecycle of the resources they provide.

`engine.dispose()` stops accepting new engine work, shuts down queries, then
waits for all accepted actions (including query lifecycle actions) to finish
and release their resources before flushing and disposing providers. Aborting
an action is cooperative: shutdown still waits for its execution and interceptor
cleanup to finish. Concurrent disposal calls await the same shutdown. A standalone
`dispatcher.dispose()` likewise stops new dispatches and drains accepted actions;
it does not dispose its container.

- **`obtain(options)`**: This method is called whenever a consumer (like an Action or Query) needs a resource. It's responsible for creating or acquiring the resource. It can optionally receive an `options` object from the consumer.

- **`release(resource, options)`**: This is the counterpart to `obtain`. It's called after the consumer has finished its work. For providers that manage a pool of resources, this is where you would return the `resource` to the pool. For singleton-like providers, this method is often a no-op.

- **`flush()`**: This optional method is called on all providers when the `engine.dispose()` method is invoked, just before the `dispose` methods are called. This is the ideal place to perform any finalization that needs to happen before resources are permanently cleaned up, especially if that finalization requires using other providers.

- **`dispose()`**: This optional method is called on all providers when the `engine.dispose()` method is invoked. It is the correct place to perform permanent cleanup of a provider's underlying resources, such as closing database connections, terminating web sockets, or completing observable streams.

-----

## Built-in Provider Implementations
`ngin` offers three built-in provider types for resource management.

### Singleton Provider
Perfect for resources that are globally shared.

```javascript
const mySingletonProvider = Provider.fromSingleton({ database: 'my-db-instance' });
```

### Pool Provider
Ideal for managing a fixed number of resources, like a pool of database
connections.

```javascript
const createConnection = async () => new DatabaseConnection();
const destroyConnection = (conn) => conn.close();
const myPoolProvider = Provider.fromPool(createConnection, destroyConnection, {size: 10});
```

### Reference-Counted Provider
Use this for resources that are lazily created and destroyed only when no
longer in use.

```javascript
const createResource = async () => new ExpensiveResource();
const destroyResource = (res) => res.cleanup();
const myRefCountedProvider = Provider.fromRefCounted(createResource, destroyResource);
```

### Lazy Singleton Provider
For a long-lived backbone — a database handle, a storage client, a search index:
built once, lazily, shared by every consumer at once, and destroyed only when
the container is.

```javascript
const myBackboneProvider = Provider.fromLazySingleton(
  async ({ config }) => {
    const cfg = await config.obtain();
    const db = new Database(cfg.url);
    await db.connect();          // building is async, and often ordered
    return db;
  },
  (db) => db.close(),
  { deps: ['config'] }
);
```

`release` is a synchronous no-op: consumers that lease the backbone on every
request should not pay teardown on the way out. The resource goes down in
`dispose`, and since the container disposes in reverse construction order,
teardown order falls out of the dependency graph instead of being maintained by
hand.

The other three do not cover this case, and the ways they miss are worth knowing:

| | lazy build | concurrent consumers | destroyed on `release` |
| --- | --- | --- | --- |
| `fromSingleton` | no — needs it already built | yes | no |
| `fromPool({size: 1})` | yes | **no — it is a mutex** | returned to the pool |
| `fromRefCounted` | yes | yes | **yes, at zero** |
| `fromLazySingleton` | yes | yes | no |

A pool of one blocks the second `obtain` until the first releases, so one slow
consumer stops every other. `fromRefCounted` shares correctly, but an ordinary
lease/release cycle drops the count to zero and tears the resource down — the
next consumer then silently gets a *different* one while whatever held the old
is still pointing at it.

### Dependencies in the built-ins

All three factories take a `deps` option. Those dependencies arrive at
`create`, `destroy` and `dispose` as **providers** — the same thing a provider
written by hand receives in its constructor — so the resource you build can
hold a dependency for its own lifetime:

```javascript
const ConnectionProvider = Provider.fromPool(
  async ({ credentials }) => {
    // Obtained in create, held by the connection, released in destroy.
    const creds = await credentials.obtain();
    return { conn: await connect(creds), credentials, creds };
  },
  async ({ conn, credentials, creds }) => {
    await conn.close();
    credentials.release(creds);
  },
  { size: 10, deps: ['credentials'] }
);
```

If a dependency is only read at creation time, obtain and release it around
that read:

```javascript
const WorkerProvider = Provider.fromPool(
  async ({ config }) => {
    const cfg = await config.obtain();
    try {
      return new Worker(cfg.workerPath);   // only the path is retained
    } finally {
      config.release(cfg);
    }
  },
  (worker) => worker.terminate(),
  { size: 4, deps: ['config'] }
);
```

Actions, queries and interceptors are the other way around: they are consumers
rather than resource managers, so they receive already-obtained **resources**,
released for them when their work finishes.

## Releasing

Push a `package.json` version bump to `main` to publish automatically. The
`Publish to npm` workflow installs dependencies, runs the tests, and checks the
package contents before publishing to npm and creating the release tag and GitHub
release with generated notes. Edits that leave the version unchanged skip release.

If a release fails before npm publication, fix the problem on `main`, then select
**Actions → Publish to npm → Run workflow → main** to retry the current version;
the tests run again. If npm publication succeeded but the GitHub release failed,
the same manual workflow completes the release using the original published
commit. Published npm versions are immutable: shipping code fixes after a version
has reached npm requires another version bump.
