// Shared internals.  Not part of the public API.

// Reports an error that has nowhere to go: one thrown by an observer callback,
// by a teardown routine, or by a provider being disposed.  Funnelled through a
// single helper so every "swallowed" error surfaces the same way.
export function report(error) {
  console.error(error);
}
