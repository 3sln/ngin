# Actions and Interceptors

Actions represent the "verbs" of your application. They perform side effects, modify state, or coordinate other logic.

## Defining Actions

An Action is a class that extends `Action` and implements an `execute` method. It declares its dependencies via a static `deps` property.

```javascript
import { Action } from '@3sln/ngin';

class SendEmailAction extends Action {
  static deps = ['api', 'logger'];

  constructor(recipient, message) {
    super();
    this.recipient = recipient;
    this.message = message;
  }

  async execute({ api, logger }, { dispatchFeed, engineFeed, state }) {
    logger.log(`Sending email to ${this.recipient}`);
    await api.sendEmail(this.recipient, this.message);
    
    // Use dispatchFeed to send events back to the specific caller of this action
    dispatchFeed.dispatchEvent(new CustomEvent('sent', { detail: { to: this.recipient } }));

    // Use engineFeed for global communication across the entire application
    engineFeed.dispatchEvent(new CustomEvent('email-stats-updated'));
  }
}
```

## The Execution Context

The second argument to `execute` is a context object containing:

*   **`dispatchFeed`**: A local `EventTarget` unique to this specific action dispatch. Use this to communicate progress or results back to the caller who invoked `engine.dispatch()`.
*   **`engineFeed`**: The global `EventTarget` for the entire `Engine` instance. Use this for cross-cutting events that other parts of the system (or other providers/actions) might care about.
*   **`state`**: A shared state object that can be modified by interceptors.

## Dispatching Actions

Actions are dispatched via the `Engine`. The `dispatch` method returns the `dispatchFeed` for that action.

```javascript
const feed = engine.dispatch(new SendEmailAction('user@example.com', 'Hello!'));

feed.addEventListener('complete', () => {
  console.log('Action completed successfully');
});

feed.addEventListener('error', (e) => {
  console.error('Action failed:', e.error);
});
```

## Event-Driven Communication

In `ngin`, Actions and Queries are designed to be decoupled. They generally should **not** dispatch other actions directly. Instead, they communicate via the `engineFeed`.

### The `engineFeed`

Both Actions (in `execute`) and Queries (in `boot`/`kill`) have access to `engineFeed`. This is a global `EventTarget` shared by the Engine.

*   **Actions** emit events to `engineFeed` to signal significant state changes or side effects.
*   **Queries** can listen to `engineFeed` to update their local state or trigger re-fetches.

### The "Choreographer" Pattern

Since Actions shouldn't dispatch other actions, the recommended pattern is to have your main application code (or a dedicated "choreographer" layer) listen to the `engineFeed` and dispatch subsequent actions in response to events.

```javascript
// 1. Action emits an event upon completion
class LoginAction extends Action {
  async execute({ api }, { engineFeed }) {
    const user = await api.login();
    // Signal that login occurred
    engineFeed.dispatchEvent(new CustomEvent('user-login', { detail: user }));
  }
}

// 2. App listens to the feed and orchestrates the next steps
engine.feed.addEventListener('user-login', (e) => {
  const user = e.detail;
  // Dispatch subsequent actions
  engine.dispatch(new LoadDashboardAction(user.id));
  engine.dispatch(new ConnectChatAction(user.id));
});
```

This approach ensures that `LoginAction` remains reusable and testable, as it is not coupled to the logic of what happens *after* a login.
