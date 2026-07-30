# Interceptors

Interceptors are middleware that wrap work. They let you add cross-cutting
concerns -- access checks, metrics, usage tracking, logging, error handling --
without cluttering your business logic.

They wrap **both** of the things that do work: an Action being dispatched, and a
Query being realized. One list, registered once, covers both.

## Defining Interceptors

An interceptor is an object that can implement four optional lifecycle methods:
`enter`, `leave`, `error` and `abort`.

```javascript
const myInterceptor = {
  // Interceptors can have dependencies just like Actions and Queries
  deps: ['logger'],

  async enter({ logger }, { action, query, state, engineFeed }) {
    logger.log(`Entering ${(action ?? query).constructor.name}`);
    // You can return a new state object to be passed to the work and to the
    // interceptors after this one
    return { ...state, startTime: Date.now() };
  },

  async leave({ logger }, { action, query, state }) {
    const duration = Date.now() - state.startTime;
    logger.log(`${(action ?? query).constructor.name} took ${duration}ms`);
  },

  async error({ logger }, { error, handled, state }) {
    logger.error('failed:', error);

    // Custom error handling logic...
    if (error.isRecoverable) {
      handled(); // Mark the error as handled
    }
  }
};
```

## Actions or Queries?

The context tells you which kind of work you were called for, by name:

| Key | Present for | Also on the context |
| --- | --- | --- |
| `action` | a dispatch | `dispatchFeed`, `signal` |
| `query` | a query | `bootFeed`, `killFeed` |

`engineFeed` and `state` are on both. An interceptor that only counts, times or
checks access can ignore the difference entirely:

```javascript
const usage = {
  deps: ['metrics'],
  enter: ({ metrics }, { action, query }) => {
    metrics.increment(action ? 'action' : 'query', (action ?? query).constructor.name);
  },
};
```

One that reaches into the work switches on the key it needs:

```javascript
const accessCheck = {
  deps: ['session'],
  enter: ({ session }, { action, query }) => {
    const required = (action ?? query).requires;
    if (required && !session.can(required)) {
      throw new Error(`Not permitted: ${required}`);
    }
  },
};
```

> An interceptor never shapes a result. What an action's `execute` returns is
> already nothing; what a query emits to its subscribers, and what `peek()`
> resolves with, come back untouched no matter what the hooks return. A hook's
> return value goes to `state` and nowhere else.

## Lifecycle Phases

For an **action**, and for a query answered by `fetch`, the three phases happen
in one go:

1.  **`enter`**: before the work, in the order the interceptors are registered.
2.  **The work**: the Action's `execute`, or the Query's `fetch`.
3.  **`leave` / `error`**: after it, in **reverse** order.

For a **live query** -- one with a `boot` -- the same three phases are stretched
over its lifetime:

1.  **`enter`**: before the query boots, and before its `bootAction` is
    dispatched or its resources are leased. This is what lets an access check
    refuse a query before anything happens on its behalf.
2.  **The query**: boot, then however long it goes on emitting.
3.  **`leave` / `error`**: once the last observer has unsubscribed and the query
    has been killed, its lease released.

So an interceptor that opens something in `enter` holds it for as long as the
query lives. That is the point -- it is how a query gets a transaction, a span,
or a permit for its whole lifetime -- but it is worth knowing before you put an
expensive resource in there.

Which queries run which shape:

```
subscribe to a live query   enter, boot ... kill, leave
subscribe to a one-shot     enter, fetch, leave
peek() an inactive query    enter, fetch, leave
peek() an active query      nothing -- it was entered when it booted
```

Two things follow from that, and matter most to anything counting:

*   **A query is entered once per realization, not once per subscriber.** The
    second observer of a query that is already running joins the one that is
    live; there is no second `enter`, and `leave` runs when the *last* of them
    unsubscribes.
*   **A `bootAction` or `killAction` is a dispatch in its own right**, so it
    runs the stack again with `action` set, nested inside the query's.

## The `abort` Hook

A dispatch can be abandoned: `feed.abort(reason)` says the caller is no longer
interested, and interceptors unwind through `abort` instead of `leave`. It
matters because of what `leave` means to the obvious interceptor --
enter/begin, leave/commit, error/rollback -- which without an `abort` hook
commits the work of a dispatch that was cancelled half way through.

```javascript
const transaction = {
  deps: ['db'],
  enter: ({ db }) => db.begin(),
  leave: ({ db }) => db.commit(),
  error: ({ db }) => db.rollback(),
  abort: ({ db }) => db.rollback(),   // without this, `leave` commits
};
```

Queries have nothing to abort -- a query ends when its last observer leaves --
so this hook only ever fires for an action.

```
aborted   -> abort ?? (error ? error : leave)
error     -> error ?? nothing
otherwise -> leave ?? nothing
```

## Error Handling

The `error` hook receives an `errorContext` with a `handled()` function. By
default, if the work or an interceptor throws, the dispatch fails and the
`error` event is emitted on the `dispatchFeed`; a query dies, and its observers
are told.

If an interceptor calls `handled()`, the error is "caught". The error state is
cleared, and the remaining interceptors in the stack (the "outer" ones) get
`leave` instead of `error`. This allows inner interceptors to recover from
errors (e.g. refreshing a token) so that outer interceptors (e.g. logging) see a
successful execution.

```javascript
const errorInterceptor = {
  error: (resources, { error, handled }) => {
    if (error instanceof ValidationError) {
      console.warn('Validation failed, but we can continue:', error.message);
      handled(); // Error is cleared; outer interceptors will run 'leave'
    }
  }
};
```

> `handled()` means less for a query than for an action. A dispatch whose error
> is handled completes; a query is already dead by the time the stack unwinds --
> its observers have been told, its lease released -- so handling the error
> changes only what the interceptors outside it see. It cannot bring the query
> back.

## Unwinding a Failed `enter`

An interceptor whose `enter` throws is still unwound: its own `error` handler
runs, then the ones outside it. This means an interceptor's `error` can be
called even though its `enter` never completed, so keep error handlers tolerant
of partially-established state.

Every interceptor that entered gets exactly **one** unwind call, whichever way
the work ended -- and a query that fails to boot is unwound there and then, so
being killed afterwards does not unwind it a second time.

## Registering Interceptors

Interceptors are registered when creating the `Engine` instance, which hands the
list to both layers, or on the `Dispatcher` and `QueryStore` directly if you are
using them without an engine. The list is copied at construction time; mutating
it afterwards has no effect.

```javascript
const engine = new Engine({
  providers: { ... },
  interceptors: [
    loggingInterceptor,
    authInterceptor,
    errorInterceptor
  ]
});
```

```javascript
// The same, by hand. Pass the same list to both to get engine behaviour, or
// different lists if a concern really does belong to only one of them.
const dispatcher = new Dispatcher({ container, interceptors });
const queries = new QueryStore({ container, dispatcher, interceptors });
```
