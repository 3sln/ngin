# Queries

Queries represent the "nouns" or the state of your application. They provide a reactive way to access data.

## Defining Queries

A Query extends the `Query` class. It manages its own lifecycle via `boot` (called when the first observer subscribes) and `kill` (called when the last observer unsubscribes).

```javascript
import { Query } from '@3sln/ngin';

class CurrentTimeQuery extends Query {
  boot(resources, { notify }) {
    // Start emitting values
    this.interval = setInterval(() => {
      notify(new Date());
    }, 1000);
    
    // Emit initial value
    notify(new Date());
  }

  kill() {
    // Cleanup
    clearInterval(this.interval);
  }
}
```

## Using Queries

To use a query, you pass an instance to `engine.query()`, or to a `QueryStore`
directly if you do not need the rest of the library. This returns an object
with a `subscribe` method (compatible with RxJS).

```javascript
import { Container } from '@3sln/ngin/providers';
import { QueryStore } from '@3sln/ngin/queries';

const queries = new QueryStore({ container: new Container({ providers }) });

// `engine.query(...)` delegates to exactly this.
queries.query(new CurrentTimeQuery());
```

```javascript
const query = engine.query(new CurrentTimeQuery());

const subscription = query.subscribe(time => {
  console.log('Current time:', time);
});

// Later...
subscription.unsubscribe();
```

## Peeking at Values

You can also use `peek()` to get the current value without subscribing.

```javascript
const time = await query.peek();
```

An **active** query -- one with subscribers -- answers the peek itself: you get
its last emitted value, or, if it has not emitted yet, you wait for its first
one. An **inactive** query is answered by calling its `fetch` method, and
`peek()` throws if the query does not implement one.

> A live query that never emits leaves `peek()` pending until it is killed.
> That is deliberate: `fetch` is not used as a shortcut past a query that is
> already running, because the two can disagree. If you cannot block, race the
> peek against a timeout yourself.

## Completion

`complete()` is called on observers that are still attached when a query dies
-- because the store was disposed, or because `boot` threw. It is **not**
called on an observer that unsubscribes, the same as RxJS: withdrawing is not
the query ending. Use it as a signal that the source went away underneath you.

## Dependencies in Queries

Queries can also have dependencies, just like Actions.

```javascript
class UserQuery extends Query {
  static deps = ['api'];
  
  constructor(userId) {
    super();
    this.userId = userId;
  }
  
  async boot({ api }, { notify }) {
    const user = await api.getUser(this.userId);
    notify(user);
    
    // Maybe set up a socket listener for updates...
  }
}
```

## Query Context

The `boot` and `kill` methods receive a context object as their second argument providing access to the engine and lifecycle feeds.

*   **`notify(value)`**: Call this to push a new value to subscribers.
*   **`engineFeed`**: The global `EventTarget` for the engine. Useful for listening to global events.
*   **`bootFeed`**: The `EventTarget` for the `bootAction` (if one was defined).
*   **`killFeed`**: The `EventTarget` for the `killAction` (available in `kill`).

## Dynamic `kill` Assignment

A common pattern is to define the `kill` method *inside* the `boot` method. This allows the `kill` function to access variables or closures created during boot, such as specific event listener functions or resource handles.

```javascript
class MouseQuery extends Query {
  static deps = ['window'];

  boot({ window }, { notify }) {
    const onMove = (e) => notify({ x: e.clientX, y: e.clientY });
    
    window.addEventListener('mousemove', onMove);
    
    // Assign kill dynamically to capture 'onMove' closure
    this.kill = () => {
      window.removeEventListener('mousemove', onMove);
    };
  }
}
```

## Lifecycle Actions

Queries can trigger actions automatically when they start (`boot`) or stop (`kill`) by setting the `bootAction` and `killAction` properties.

A `QueryStore` used on its own has nothing to dispatch through, so it needs a
dispatcher for these:

```javascript
const queries = new QueryStore({ container, dispatcher });
```

An `Engine` wires that up for you.

Lifecycle actions are fire-and-forget: nothing waits on their result. If one
fails, the failure is reported on `console.error` naming the query and the
action, since there is no caller to propagate it to. To react to one, listen on
the `bootFeed` your query is given.

```javascript
class UserQuery extends Query {
  constructor(userId) {
    super();
    // These actions are automatically dispatched by the engine
    this.bootAction = new FetchUserAction(userId);
    this.killAction = new CleanupUserAction(userId);
  }

  boot(resources, { bootFeed, notify }) {
    // You can listen to the bootAction's progress
    bootFeed.addEventListener('complete', () => {
      console.log('User fetch completed');
    });
  }
}
```
```
