# Interceptors

Interceptors are middleware that wrap Action execution. They allow you to inject cross-cutting concerns like logging, authentication, analytics, or error handling without cluttering your business logic.

## Defining Interceptors

An interceptor is an object that can implement three optional lifecycle methods: `enter`, `leave`, and `error`.

```javascript
const myInterceptor = {
  // Interceptors can have dependencies just like Actions
  deps: ['logger'],

  async enter({ logger }, { action, state, dispatchFeed, engineFeed }) {
    logger.log(`Entering ${action.constructor.name}`);
    // You can return a new state object to be passed to the action and next interceptors
    return { ...state, startTime: Date.now() };
  },

  async leave({ logger }, { action, state, dispatchFeed, engineFeed }) {
    const duration = Date.now() - state.startTime;
    logger.log(`${action.constructor.name} completed in ${duration}ms`);
  },

  async error({ logger }, { action, state, error, handled }) {
    logger.error(`${action.constructor.name} failed:`, error);
    
    // Custom error handling logic...
    if (error.isRecoverable) {
      handled(); // Mark the error as handled to prevent it from failing the dispatch
    }
  }
};
```

## Lifecycle Phases

1.  **`enter`**: Called before the Action's `execute` method. Interceptors are executed in the order they are defined in the Engine.
2.  **Action Execution**: The Action's `execute` method is called.
3.  **`leave` / `error`**: 
    *   If execution was successful, `leave` is called on all interceptors in **reverse order**.
    *   If an error occurred, `error` is called on all interceptors in **reverse order**.

## Error Handling

Interceptors provide a powerful way to centralize error handling.

The `error` method receives an `errorContext` with a `handled()` function. By default, if an action or an interceptor throws, the dispatch fails and the `error` event is emitted on the `dispatchFeed`.

If an interceptor calls `handled()`, the error is effectively "caught". The Engine clears the error state, and for all remaining interceptors in the stack (the "outer" ones), the `leave` method will be called instead of `error`.

This allows inner interceptors to recover from errors (e.g., refreshing a token) so that outer interceptors (e.g., logging) see a successful execution.

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

## Registering Interceptors

Interceptors are registered when creating the `Engine` instance.

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
