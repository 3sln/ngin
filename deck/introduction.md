# Introduction to Ngin

`ngin` is a lightweight and flexible state management library and business logic abstraction layer designed to help you organize your application logic. It uses a dependency injection model to coordinate resources, actions, and queries, keeping your code clean and testable in any environment (frontend, backend, CLI, etc.).

## Core Concepts

*   **Engine**: The central hub that manages dependencies and coordinates actions and queries.
*   **Provider**: Manages the lifecycle of resources (services, data connections, config).
*   **Action**: Encapsulates a discrete unit of work or side effect (e.g., "Login", "FetchData").
*   **Query**: Encapsulates a reactive data source (e.g., "CurrentUser", "SearchResults").
*   **Interceptor**: Middleware that wraps actions to add cross-cutting concerns like logging or error handling.

## Installation

```bash
npm install @3sln/ngin
```

## Quick Start

Here is a simple example of how to set up an engine, define a provider, and dispatch an action.

```javascript
import { Engine, Action, Provider } from '@3sln/ngin';

// 1. Define a Provider
class ConsoleProvider extends Provider {
  obtain() {
    return console;
  }
}

// 2. Define an Action
class GreetAction extends Action {
  static deps = ['console'];
  
  constructor(name) {
    super();
    this.name = name;
  }

  execute({ console }) {
    console.log(`Hello, ${this.name}!`);
  }
}

// 3. Create the Engine
const engine = new Engine({
  providers: {
    console: ConsoleProvider,
  },
});

// 4. Dispatch the Action
engine.dispatch(new GreetAction('World'));
```
