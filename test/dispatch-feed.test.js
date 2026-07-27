import { test, expect } from 'bun:test';
import { Container, Provider } from '../src/providers.js';
import { Action, Dispatcher, DispatchFeed } from '../src/actions.js';

const dispatcherWith = (interceptors) =>
  new Dispatcher({ container: new Container({ providers: {} }), interceptors });

// An action built from a function, so each test reads as one thing.
const acting = (execute) =>
  new (class extends Action {
    execute(resources, context) {
      return execute(resources, context);
    }
  })();

const emit = (feed, type, detail) => {
  const event = new Event(type);
  event.detail = detail;
  feed.dispatchEvent(event);
};

// --- next() ----------------------------------------------------------------

test('resolves with the event the action emitted', async () => {
  const feed = dispatcherWith().dispatch(
    acting((_, { dispatchFeed }) => emit(dispatchFeed, 'result', 42))
  );
  expect((await feed.next('result')).detail).toBe(42);
});

test('takes several names and answers with whichever arrives', async () => {
  const feed = dispatcherWith().dispatch(
    acting((_, { dispatchFeed }) => emit(dispatchFeed, 'miss', 'not found'))
  );
  const event = await feed.next(['hit', 'miss']);
  expect([event.type, event.detail]).toEqual(['miss', 'not found']);
});

test('the first of the named events wins', async () => {
  const feed = dispatcherWith().dispatch(
    acting((_, { dispatchFeed }) => {
      emit(dispatchFeed, 'result', 'first');
      emit(dispatchFeed, 'result', 'second');
    })
  );
  expect((await feed.next('result')).detail).toBe('first');
});

test('progress can be watched while the result is awaited', async () => {
  // The reason results come through a feed at all: a return value cannot say
  // "40%" on the way to saying "done".
  const seen = [];
  const feed = dispatcherWith().dispatch(
    acting(async (_, { dispatchFeed }) => {
      for (const done of [25, 50, 100]) emit(dispatchFeed, 'progress', done);
      emit(dispatchFeed, 'result', 'finished');
    })
  );
  feed.addEventListener('progress', (event) => seen.push(event.detail));
  expect((await feed.next('result')).detail).toBe('finished');
  expect(seen).toEqual([25, 50, 100]);
});

test('rejects with the action\'s own error, not a wrapper', async () => {
  // The thrown object arrives intact, so a caller that maps error types to
  // HTTP statuses can still see what was thrown.
  const boom = Object.assign(new Error('nope'), { status: 418 });
  const feed = dispatcherWith().dispatch(acting(() => { throw boom; }));
  expect(feed.next('result')).rejects.toBe(boom);
});

test('rejects rather than hanging when the action never emits', async () => {
  // The failure this exists to prevent: a promise with no timeout, no
  // cancellation and no error, waiting on an event that can no longer fire.
  const feed = dispatcherWith().dispatch(acting(() => {}));
  expect(feed.next('result')).rejects.toThrow(/completed without emitting 'result'/);
});

test('naming complete opts back in to receiving it', async () => {
  const feed = dispatcherWith().dispatch(acting(() => {}));
  expect((await feed.next(['result', 'complete'])).type).toBe('complete');
});

test('naming error opts back in to receiving it as a value', async () => {
  const feed = dispatcherWith().dispatch(acting(() => { throw new Error('nope'); }));
  const event = await feed.next(['result', 'error']);
  expect([event.type, event.error.message]).toEqual(['error', 'nope']);
});

test('answers a caller that arrives after the dispatch is over', async () => {
  // A dispatch ends on exactly one of complete/error/abort, once. A caller that
  // awaits something else first would otherwise be waiting on an event that has
  // already gone past.
  const feed = dispatcherWith().dispatch(
    acting((_, { dispatchFeed }) => emit(dispatchFeed, 'result', 'late'))
  );
  await feed.next('complete');
  expect(feed.settled).toBe('complete');
  // The result event itself is long gone, but the terminal state is not.
  expect(feed.next('result')).rejects.toThrow(/completed without emitting/);
  expect((await feed.next('complete')).type).toBe('complete');
});

test('a failed dispatch still rejects a caller that arrives late', async () => {
  const feed = dispatcherWith().dispatch(acting(() => { throw new Error('nope'); }));
  await feed.next(['error']);
  expect(feed.next('result')).rejects.toThrow('nope');
});

test('requires at least one event name', () => {
  const feed = new DispatchFeed();
  expect(() => feed.next([])).toThrow(TypeError);
});

test('listeners are removed once it settles', async () => {
  // Every next() attaches a listener per name plus one per terminal event. A
  // request handler runs this per request, so leaving them attached would be a
  // leak on the hot path.
  const feed = dispatcherWith().dispatch(
    acting((_, { dispatchFeed }) => emit(dispatchFeed, 'result', 1))
  );
  await feed.next('result');
  let after = 0;
  feed.addEventListener('result', () => { after++; });
  emit(feed, 'result', 2);
  expect(after).toBe(1); // only the listener added just now
});

// --- abort() ---------------------------------------------------------------

test('the action is handed a signal it can stop on', async () => {
  // Aborted while genuinely mid-run, not before it started: the action says so
  // itself rather than the test guessing at the scheduler.
  let stoppedAt = null;
  const feed = dispatcherWith().dispatch(
    acting(async (_, { signal, dispatchFeed }) => {
      for (let i = 0; i < 100; i++) {
        if (i === 3) emit(dispatchFeed, 'running', i);
        if (signal.aborted) { stoppedAt = i; return; }
        await new Promise((resolve) => setTimeout(resolve));
      }
      emit(dispatchFeed, 'result', 'ran to the end');
    })
  );
  await feed.next('running');
  feed.abort();
  await feed.next('abort');
  expect(stoppedAt).toBeGreaterThanOrEqual(3);
  expect(stoppedAt).toBeLessThan(100);
});

test('aborting rejects anything waiting, without waiting for the action', async () => {
  // The point of giving up is not to keep waiting. The action is cooperative
  // and may take a while to notice; the caller does not have to.
  const feed = dispatcherWith().dispatch(
    acting(() => new Promise((resolve) => setTimeout(resolve, 50)))
  );
  const pending = feed.next('result');
  feed.abort(new Error('client went away'));
  expect(pending).rejects.toThrow('client went away');
});

test('the abort reason reaches the action', async () => {
  let reason = null;
  const feed = dispatcherWith().dispatch(
    acting(async (_, { signal }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      reason = signal.reason;
    })
  );
  feed.abort(new Error('cancelled by user'));
  await feed.next('abort');
  expect(reason.message).toBe('cancelled by user');
});

test('next() called after an abort rejects immediately', async () => {
  const feed = dispatcherWith().dispatch(acting(() => new Promise(() => {})));
  feed.abort(new Error('gone'));
  expect(feed.next('result')).rejects.toThrow('gone');
});

test('aborting before the action starts still reaches it', async () => {
  // dispatch() returns synchronously and the action runs on a later turn, so
  // this is a real ordering, not a contrived one.
  let sawAborted = null;
  const feed = dispatcherWith().dispatch(
    acting((_, { signal, dispatchFeed }) => {
      sawAborted = signal.aborted;
      emit(dispatchFeed, 'result', 'ran anyway');
    })
  );
  feed.abort();
  // The action still runs: skipping it would skip the interceptor unwinding
  // with it, and an interceptor that opened something has to close it.
  expect((await feed.next(['result', 'abort'])).type).toBe('result');
  expect(sawAborted).toBe(true);
});

test('interceptors see the same signal', async () => {
  const seen = [];
  const dispatcher = dispatcherWith([
    {
      enter: (_, { signal }) => { seen.push(['enter', signal.aborted]); },
      leave: (_, { signal }) => { seen.push(['leave', signal.aborted]); },
    },
  ]);
  const feed = dispatcher.dispatch(
    acting(async (_, { dispatchFeed }) => {
      dispatchFeed.abort();
      emit(dispatchFeed, 'result', 1);
    })
  );
  await feed.next('abort');
  expect(seen).toEqual([['enter', false], ['leave', true]]);
});

test('an error interceptor sees the signal too', async () => {
  let sawSignal = false;
  const dispatcher = dispatcherWith([
    { error: (_, { signal }) => { sawSignal = signal instanceof AbortSignal; } },
  ]);
  const feed = dispatcher.dispatch(acting(() => { throw new Error('nope'); }));
  await feed.next(['error']);
  expect(sawSignal).toBe(true);
});

// --- an aborted dispatch did not complete ----------------------------------

test('an aborted dispatch ends on abort, never on complete', async () => {
  // The whole point. A scan stopped at thirty percent did not complete, and
  // saying it did is how "it worked" gets reported about work that did not
  // happen.
  const ended = [];
  const feed = dispatcherWith().dispatch(
    acting(async (_, { signal }) => {
      while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve));
    })
  );
  for (const type of ['complete', 'error', 'abort']) {
    feed.addEventListener(type, (event) => ended.push(event.type));
  }
  feed.abort(new Error('stopped'));
  await feed.next('abort');
  expect(ended).toEqual(['abort']);
  expect(feed.settled).toBe('abort');
});

test('the abort event carries the reason', async () => {
  const why = new Error('client disconnected');
  const feed = dispatcherWith().dispatch(acting(() => {}));
  feed.abort(why);
  expect((await feed.next('abort')).reason).toBe(why);
});

test('an action that threw on its way out still ends on abort, error and all', async () => {
  // An action that honours the signal by throwing threw *because* of the abort.
  // Reporting the throw would name the symptom rather than the cause — but the
  // error is carried along, so nothing is lost by saying abort.
  const thrown = new Error('aborted mid-write');
  const feed = dispatcherWith().dispatch(
    acting(async (_, { signal }) => {
      while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve));
      throw thrown;
    })
  );
  feed.abort(new Error('gave up'));
  const event = await feed.next('abort');
  expect(event.type).toBe('abort');
  expect(event.error).toBe(thrown);
  expect(feed.settled).toBe('abort');
});

test('waiting for complete on an aborted dispatch rejects rather than hanging', async () => {
  // `complete` will now never fire, so a caller waiting on it has to be told.
  const feed = dispatcherWith().dispatch(
    acting(async (_, { signal }) => {
      while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve));
    })
  );
  const pending = feed.next(['complete']);
  feed.abort(new Error('gave up'));
  expect(pending).rejects.toThrow('gave up');
});

test('a late caller on an aborted dispatch is told the reason', async () => {
  const feed = dispatcherWith().dispatch(acting(() => {}));
  feed.abort(new Error('gave up'));
  await feed.next('abort');
  expect(feed.next('result')).rejects.toThrow('gave up');
});

test('aborting after it already finished does not rewrite how it ended', async () => {
  // A real race: the action finishes at the same moment the caller gives up.
  // What happened, happened — it completed, and the late abort does not undo it.
  const feed = dispatcherWith().dispatch(
    acting((_, { dispatchFeed }) => emit(dispatchFeed, 'result', 'done'))
  );
  await feed.next('complete');
  feed.abort(new Error('too late'));
  expect(feed.settled).toBe('complete');
  expect((await feed.next('complete')).type).toBe('complete');
});

// --- the caller's own cancellation -----------------------------------------

test('a caller signal unblocks the wait without aborting the action', async () => {
  // An HTTP handler passes the request's signal: a disconnected client should
  // stop the handler waiting, but work already underway may well be worth
  // finishing. Which one you want is the caller's call, and these are separate
  // knobs precisely so it can be made.
  let ranToCompletion = false;
  const feed = dispatcherWith().dispatch(
    acting(async (_, { dispatchFeed }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      ranToCompletion = true;
      emit(dispatchFeed, 'result', 'done anyway');
    })
  );
  const controller = new AbortController();
  const pending = feed.next('result', { signal: controller.signal });
  controller.abort(new Error('client disconnected'));
  expect(pending).rejects.toThrow('client disconnected');

  await feed.next('complete');
  expect(ranToCompletion).toBe(true);
  expect(feed.signal.aborted).toBe(false);
});

test('an already-aborted caller signal rejects without listening', async () => {
  const feed = dispatcherWith().dispatch(acting(() => {}));
  const controller = new AbortController();
  controller.abort(new Error('too late'));
  expect(feed.next('result', { signal: controller.signal })).rejects.toThrow('too late');
});

// --- what did not change ---------------------------------------------------

test('it is still an EventTarget and still emits complete and error', async () => {
  // Everything built on the old feed keeps working: queries dispatch lifecycle
  // actions and listen for 'error' on what comes back.
  const feed = dispatcherWith().dispatch(acting(() => {}));
  expect(feed).toBeInstanceOf(EventTarget);
  expect(feed).toBeInstanceOf(DispatchFeed);
  await new Promise((resolve) => feed.addEventListener('complete', resolve, { once: true }));
  expect(feed.settled).toBe('complete');
});

test('resources still reach the action alongside the new context', async () => {
  const container = new Container({
    providers: { greeting: Provider.fromSingleton('hello') },
  });
  const feed = new Dispatcher({ container }).dispatch(
    new (class extends Action {
      static deps = ['greeting'];
      execute({ greeting }, { dispatchFeed }) {
        emit(dispatchFeed, 'result', greeting);
      }
    })()
  );
  expect((await feed.next('result')).detail).toBe('hello');
});
