# tracer

Deterministic signals and reactive collections for JavaScript.

`tracer` gives you small, explicit primitives for storing values, deriving values, subscribing to changes, batching updates, and working with patch-producing collections.

## Installation / Import

This package is ESM-only.

```js
import { signal, batch, overridable } from 'tracer'
```
## Quick start

```js
import { signal } from 'tracer'

const count = signal(0)

const unsubscribe = count.subscribe(change => {
  console.log(change.kind, change.nextValue)
})

count.setValue(1)
count.setValue(value => value + 1)

unsubscribe()
```

A stored signal exposes:

- **`getValue()`**: reads the current value
- **`setValue(nextOrUpdater)`**: updates the value and returns `true` if it changed
- **`subscribe(cb)`**: subscribes to changes and returns an unsubscribe function

Subscribers are called immediately with an `init` change.

```js
{
  kind: 'init' | 'update',
  nextValue: any,
  previousValue: any,
  meta?: any
}
```

## Derived signals

Pass a function to `signal()` to create a readonly derived signal.

```js
const firstName = signal('Ada')
const lastName = signal('Lovelace')

const fullName = signal($ => `${$(firstName)} ${$(lastName)}`)

fullName.getValue() // 'Ada Lovelace'
```

The `$` function tracks dependencies. A derived signal only depends on signals you explicitly pass to `$`.

```js
const useNickname = signal(false)
const name = signal('Ada')
const nickname = signal('Enchantress of Numbers')

const displayName = signal($ => {
  return $(useNickname) ? $(nickname) : $(name)
})
```

Derived signals expose:

- **`getValue()`**
- **`subscribe(cb)`**

They do not expose `setValue()`.

## Batching updates

Use `batch(fn)` to coalesce multiple updates into one notification per affected signal.

```js
const count = signal(0)

count.subscribe(change => {
  if (change.kind === 'init') return
  console.log(change.previousValue, change.nextValue)
})

batch(() => {
  count.setValue(1)
  count.setValue(2)
  count.setValue(3)
})

// Logs once:
// 0 3
```

## Reactive arrays

Use `signal.array(initialArray)` for an array signal with explicit mutation APIs.

```js
const items = signal.array(['a', 'b'])

items.getValue() // frozen ['a', 'b']

items.index.length.subscribe(change => {
  if (change.kind === 'init') return
  console.log('length:', change.nextValue)
})

items.mutate(array => {
  array.push('c')
  array.set(0, 'A')
})
```

Array signals expose:

- **`getValue()`**
- **`setValue(nextArrayOrUpdater)`**
- **`mutate(fn)`**
- **`index.length`**: signal of the array length

Array mutators:

- **`push(...items)`**
- **`pop()`**
- **`unshift(...items)`**
- **`shift()`**
- **`splice(start, deleteCount, ...items)`**
- **`set(index, value)`**

## Derived arrays

Pass a function to `signal.array()` to create a readonly derived array signal.

```js
const first = signal('Ada')
const second = signal('Grace')

const names = signal.array($ => [
  $(first),
  $(second)
])

names.getValue() // frozen ['Ada', 'Grace']
names.index.length.getValue() // 2
```

Derived arrays expose:

- **`getValue()`**
- **`subscribe(cb)`**
- **`index.length`**

They do not expose `setValue()` or `mutate()`.

## Reactive objects

Use `signal.object(initialObject)` for a plain-object signal.

```js
const person = signal.object({
  name: 'Ada',
  age: 36
})

person.mutate(object => {
  object.set('name', 'Grace')
  object.assign({ role: 'programmer' })
})
```

Object signals expose:

- **`getValue()`**
- **`setValue(nextObjectOrUpdater)`**
- **`mutate(fn)`**
- **`index.keys`**: signal of ordered object keys
- **`index.size`**: signal of key count

Object mutators:

- **`has(key)`**
- **`get(key)`**
- **`set(key, value)`**
- **`delete(key)`**
- **`assign(partial)`**

## Derived objects

Pass a function to `signal.object()` to create a readonly derived object signal.

```js
const name = signal('Graham')
const age = signal(41)

const person = signal.object($ => ({
  name: $(name),
  age: $(age)
}))

person.getValue() // frozen { name: 'Graham', age: 41 }
person.index.keys.getValue() // frozen ['name', 'age']
person.index.size.getValue() // 2
```

Derived objects expose:

- **`getValue()`**
- **`subscribe(cb)`**
- **`index.keys`**
- **`index.size`**

They do not expose `setValue()` or `mutate()`.

## Reactive maps

Use `signal.map(initialEntries?)` for a reactive `Map`-like signal.

```js
const users = signal.map([
  ['ada', { name: 'Ada' }]
])

users.has('ada') // true
users.get('ada') // { name: 'Ada' }
users.size // 1

users.mutate(map => {
  map.set('grace', { name: 'Grace' })
})
```

Map signals expose:

- **`getValue()`**: readonly map view
- **`setValue(nextMapOrEntriesOrUpdater)`**
- **`mutate(fn)`**
- **`has(key)`**
- **`get(key)`**
- **`size`**
- **`index.keys`**: signal of ordered keys
- **`index.size`**: signal of map size
- **`key(k)`**: stable signal for one key

`key(k)` emits objects shaped like:

```js
{ present: boolean, value: any }
```

```js
const ada = users.key('ada')

ada.subscribe(change => {
  console.log(change.nextValue.present, change.nextValue.value)
})
```

Map mutators:

- **`has(key)`**
- **`get(key)`**
- **`set(key, value)`**
- **`delete(key)`**
- **`clear()`**
- **`keys()`**
- **`values()`**
- **`entries()`**

## Derived maps

Pass a function to `signal.map()` to create a readonly derived map signal.

```js
const name = signal('Graham')
const age = signal(41)

const person = signal.map($ => [
  ['name', $(name)],
  ['age', $(age)]
])

person.get('name') // 'Graham'
person.size // 2
person.index.keys.getValue() // frozen ['name', 'age']
```

Derived maps expose:

- **`getValue()`**
- **`subscribe(cb)`**
- **`has(key)`**
- **`get(key)`**
- **`size`**
- **`index.keys`**
- **`index.size`**
- **`key(k)`**

They do not expose `setValue()` or `mutate()`.

## Reactive sets

Use `signal.set(initialValues?)` for a reactive `Set`-like signal.

```js
const selectedIds = signal.set(['a'])

selectedIds.has('a') // true
selectedIds.size // 1

selectedIds.mutate(set => {
  set.add('b')
  set.delete('a')
})
```

Set signals expose:

- **`getValue()`**: readonly set view
- **`setValue(nextSetOrValuesOrUpdater)`**
- **`mutate(fn)`**
- **`has(value)`**
- **`size`**
- **`index.values`**: signal of ordered set values
- **`index.size`**: signal of set size
- **`value(v)`**: stable signal for one value's membership

`value(v)` emits objects shaped like:

```js
{ present: boolean }
```

Set mutators:

- **`has(value)`**
- **`add(value)`**
- **`delete(value)`**
- **`clear()`**
- **`keys()`**
- **`values()`**
- **`entries()`**

## Derived sets

Pass a function to `signal.set()` to create a readonly derived set signal.

```js
const first = signal('Ada')
const second = signal('Grace')

const names = signal.set($ => [
  $(first),
  $(second)
])

names.has('Ada') // true
names.size // 2
names.index.values.getValue() // frozen ['Ada', 'Grace']
```

Derived sets expose:

- **`getValue()`**
- **`subscribe(cb)`**
- **`has(value)`**
- **`size`**
- **`index.values`**
- **`index.size`**
- **`value(v)`**

They do not expose `setValue()` or `mutate()`.

## Collection patches

Stored collections publish patch bundles when they change.

```js
const state = signal.object({ name: 'Ada' })

const bundle = state.mutate(object => {
  object.set('name', 'Grace')
})

console.log(bundle)
```

A patch bundle contains:

```js
{
  patches: Patch[],
  inversePatches: Patch[]
}
```

The same bundle is also available as `change.meta` for subscribers.

```js
state.subscribe(change => {
  if (change.kind === 'init') return
  console.log(change.meta.patches)
  console.log(change.meta.inversePatches)
})
```

Patch bundles are frozen and can be used for undo/redo, persistence, debugging, or synchronization.

## Overridable signals

`overridable(baseSignal)` creates a signal wrapper that follows another signal until you explicitly override it.

```js
const serverValue = signal('light')
const localValue = overridable(serverValue)

localValue.getValue() // 'light'

localValue.setValue('dark')
localValue.getValue() // 'dark'
localValue.isOverridden // true

localValue.clear()
localValue.getValue() // follows serverValue again
```

Overridable signals expose:

- **`getValue()`**
- **`setValue(nextOrUpdater)`**
- **`clear()`**
- **`isOverridden`**
- **`subscribe(cb)`**

## API summary

```js
signal(value)
signal($ => value)

signal.array(array)
signal.array($ => array)

signal.object(object)
signal.object($ => object)

signal.map(entriesOrMap?)
signal.map($ => entriesOrMap)

signal.set(valuesOrSet?)
signal.set($ => valuesOrSet)

batch(fn)
overridable(signal)
```

## Notes

- Derived signals and derived collections are readonly.
- Collection signals use explicit mutation APIs instead of proxies.
- Collection values and patch bundles are frozen.
- `subscribe(cb)` always sends an initial `init` change.
- `setValue()` returns `false` when the value does not change.

<!-- 
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
 -->