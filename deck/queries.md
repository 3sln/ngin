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

To use a query, you pass an instance to `engine.query()`. This returns an object with a `subscribe` method (compatible with RxJS).

```javascript
const query = engine.query(new CurrentTimeQuery());

const subscription = query.subscribe(time => {
  console.log('Current time:', time);
});

// Later...
subscription.unsubscribe();
```

## Peeking at Values

You can also use `peek()` to get the current value without subscribing. If the query is active (has subscribers), it returns the last emitted value. If not, it can trigger a fetch (if `fetch` method is implemented).

```javascript
const time = await query.peek();
```

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
