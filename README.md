# tracer

Deterministic signals + reactive collections with patch bundles.

This is a small signals kernel designed for **transparent semantics** and **deterministic behavior**:

- **Deterministic dependency tracking** for derived signals via capability-passing.
- **Hot/cold derived semantics** (no hidden subscriptions when cold).
- **Batching** to coalesce notifications.
- **Reactive collections** (`array`, `object`, `map`, `set`) implemented without proxies or diffing.
- **Immutable patch bundles** (`patches` + `inversePatches`) designed to plug into `tracer-history`.

## Installation / Import

This package is ESM-only (`"type": "module"`).

If you’re working inside this repo directly:

```js
import { signal, batch, overridable } from './src/index.js'
```

If you’re using it as an installed package (i.e. `tracer` is on your `node_modules` resolution path), you typically import:

```js
import { signal, batch, overridable } from 'tracer'
```

## Core ideas

### 1) Deterministic dependency tracking (capability-passing)

Derived signals are created by passing a function that receives a single capability: `track`.

```js
const count = signal(1)

const doubled = signal(track => {
  const c = track(count)
  return c * 2
})
```

This is intentionally different from “ambient” tracking models:

- Dependencies are only captured when you call `track(dep)`.
- Nothing “magically” subscribes because you happened to read a value in a reactive context.
- You can build derived values with **dynamic dependencies**, and the library will subscribe/unsubscribe correctly.

```js
const useA = signal(true)
const a = signal(1)
const b = signal(10)

const chosen = signal(track => track(useA) ? track(a) : track(b))
```

### 2) Hot/cold semantics for derived signals

Derived signals have two modes:

- **Cold** (no subscribers)
  - Holds **no upstream subscriptions**.
  - Recomputes on `getValue()`.

- **Hot** (has subscribers)
  - Subscribes to upstream dependencies.
  - Recomputes and notifies when dependencies change.
  - Tears down upstream subscriptions automatically on last unsubscribe.

This keeps “read-only computations” cheap when no one is listening, and avoids hidden retained subscriptions.

### 3) Batching (`batch(fn)`)

`batch(fn)` coalesces many updates into a single downstream notification per signal.

```js
const s = signal(0)

batch(() => {
  s.setValue(1)
  s.setValue(2)
  s.setValue(3)
})
```

Subscribers see one `update` with:

- `previousValue`: value at the start of the batch
- `nextValue`: final value at the end of the batch

Batch flushing occurs even if an error is thrown inside the batch (the error is rethrown after flushing).

## API overview

### `signal(initialValue)` (stored signal)

Creates a mutable signal:

- `getValue(): any`
- `setValue(nextOrUpdater): boolean` (returns `false` on no-op)
- `subscribe(cb): () => void`

`subscribe(cb)` calls `cb` immediately with an `init` change.

### `signal(track => compute(track))` (derived signal)

Creates a computed signal:

- `getValue(): any`
- `subscribe(cb): () => void`

Derived signals do **not** expose `setValue`.

### `batch(fn)`

Batches notifications across any signals updated during `fn`.

### `overridable(baseSignal)`

Wraps a signal so it can temporarily stop following its base value.

```js
const base = signal(1)
const o = overridable(base)

o.getValue()     // 1
o.setValue(10)   // overrides base
o.getValue()     // 10
o.clear()        // returns to following base
```

## Change objects

Subscribers receive **change objects**:

```js
{
  kind: 'init' | 'update',
  nextValue: any,
  previousValue: any,
  meta?: any
}
```

Notable properties:

- `init` changes have `previousValue === undefined`.
- `update` changes contain both `previousValue` and `nextValue`.
- `meta` is used heavily by reactive collections to publish patch bundles.

## Reactive collections

Collections are implemented with explicit mutation APIs (no proxies, no diffing). Each collection supports:

- `getValue()` returning a frozen snapshot / view
- `setValue(nextOrUpdater)` to replace the entire value
- `mutate(fn)` to perform granular edits and emit patch bundles

### Patch bundles (immutable)

On collection mutations, `mutate(fn)` returns either:

- `null` (no-op mutation)
- a frozen bundle:

```js
{
  patches: Patch[],
  inversePatches: Patch[]
}
```

The same bundle is also published to subscribers as `change.meta`.

Design points:

- **Deep immutability**: bundles, patch arrays, and patch objects are frozen.
- **Undo-friendly**: `inversePatches` are recorded in the correct order to undo the mutation.
- **Batch-friendly**: when multiple mutations happen in a `batch()`, patch bundles compose deterministically.

### `signal.array(initialArray)`

```js
const items = signal.array([1, 2, 3])

items.index.length.subscribe(change => {
  if (change.kind === 'init') return
  console.log('length changed:', change.nextValue)
})

const bundle = items.mutate(m => {
  m.push(4)
  m.set(0, 10)
})

// bundle.patches / bundle.inversePatches describe the mutation
```

Array mutators include `push`, `pop`, `shift`, `unshift`, `splice`, `set`.

### `signal.object(initialObject)`

Reactive object with key indices:

- `index.keys`: signal of `string[]`
- `index.size`: signal of `number`

Mutators include `set(key, value)`, `delete(key)`, `assign(partial)`.

### `signal.map(initialEntries?)`

Reactive `Map` with:

- `index.keys`: signal of ordered keys
- `index.size`: signal of size
- `key(k)`: a stable derived signal describing a single key:
  - `{ present: boolean, value: any }`

```js
const m = signal.map([[1, 'a']])
const k1 = m.key(1)

k1.subscribe(change => {
  if (change.kind === 'init') return
  console.log(change.nextValue) // { present, value }
})
```

### `signal.set(initialValues?)`

Reactive `Set` with:

- `index.values`: signal of ordered values
- `index.size`: signal of size
- `value(v)`: a stable derived signal describing membership:
  - `{ present: boolean }`

## History integration (`tracer-history`)

Collection mutations produce exactly what patch-based history wants: a `{ patches, inversePatches }` bundle.

`tracer-history` is intentionally generic: you provide `applyPatches(patches)` that knows how to interpret your patch format.

### Pattern A: record bundles produced by `mutate()`

```js
import createHistory from 'tracer-history'
import { signal } from 'tracer'

const state = signal.object({ name: 'Ada' })

let applyingHistory = false
const history = createHistory({
  limit: 100,
  applyPatches: patches => {
    applyingHistory = true
    try {
      // Minimal example: apply patches by converting to a full replacement.
      // (You can also implement a patch interpreter; the important part is
      // that you DO NOT call history.record() while applying.)
      const next = { ...state.getValue() }
      for (const p of patches) {
        if (p.op === 'set') next[p.key] = p.value
        else if (p.op === 'delete') delete next[p.key]
        else if (p.op === 'replace') {
          Object.assign(next, p.value)
        }
      }
      state.setValue(next)
    } finally {
      applyingHistory = false
    }
  }
})

function mutateWithHistory (fn) {
  const bundle = state.mutate(fn)
  if (!bundle) return
  if (applyingHistory) return
  history.record(bundle)
}

mutateWithHistory(m => m.set('name', 'Grace'))
history.undo()
history.redo()
```

### Pattern B: scalar signals + custom patches

For plain stored signals, you can emit your own patches:

```js
const count = signal(0)

const history = createHistory({
  applyPatches: patches => {
    for (const p of patches) {
      if (p.op !== 'set') throw new Error('Unexpected patch op')
      if (p.name === 'count') count.setValue(p.value)
    }
  }
})

function setWithHistory (name, sig, value) {
  const previous = sig.getValue()
  history.perform({
    patches: [{ op: 'set', name, value }],
    inversePatches: [{ op: 'set', name, value: previous }]
  })
}

setWithHistory('count', count, 1)
history.undo()
```

## What makes this library different

- **No ambient tracking**: dependencies are explicit and deterministic.
- **No hidden subscriptions**: cold derived values do not retain upstream subscriptions.
- **No proxies / diffing**: collections mutate through explicit APIs.
- **Patch-first design**: mutation bundles are immutable, undo-friendly, and batch-composable.
- **History-ready**: patches + inverse patches are first-class, designed to integrate with `tracer-history`.
