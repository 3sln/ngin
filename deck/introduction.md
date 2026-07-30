# Introduction to Ngin

`ngin` is a lightweight and flexible state management library and business logic abstraction layer designed to help you organize your application logic. It uses a dependency injection model to coordinate resources, actions, and queries, keeping your code clean and testable in any environment (frontend, backend, CLI, etc.).

## Core Concepts

*   **Provider**: Manages the lifecycle of resources (services, data connections, config).
*   **Container**: Instantiates a graph of providers and hands out their resources.
*   **Action**: Encapsulates a discrete unit of work or side effect (e.g., "Login", "FetchData").
*   **Interceptor**: Middleware that wraps actions *and* queries to add cross-cutting concerns like access checks, metrics, usage tracking, logging or error handling.
*   **Query**: Encapsulates a reactive data source (e.g., "CurrentUser", "SearchResults").
*   **Engine**: A facade that builds a container, a dispatcher and a query store and wires them together.

These are grouped into three independent layers, each with its own entry point,
so you can use dependency injection on its own, dependency injection plus
actions, or the whole thing. See [Layers](/layers.md).

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
