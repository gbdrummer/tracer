import SubscriptionManager from '../core/SubscriptionManager.js'
import { createUpdateChange } from '../core/change.js'
import createDerivedSignal from '../core/createDerivedSignal.js'
import createIndexSignal from './createIndexSignal.js'
import { createStableSnapshotSignal } from './utilities.js'
import { assertNotInDerivedCompute, composeSignal } from '../core/utilities.js'

function createSetView (setData) {
  const view = {
    get size () { return setData.size },

    has: value => setData.has(value),

    keys: () => setData.keys(),
    values: () => setData.values(),
    entries: () => setData.entries(),

    forEach: (cb, thisArg) => {
      if (typeof cb !== 'function') throw new TypeError('Set view forEach(cb, thisArg) expects cb to be a function')
      setData.forEach(v => cb.call(thisArg, v, v, view))
    },

    [Symbol.iterator]: () => setData[Symbol.iterator]()
  }

  return Object.freeze(view)
}

function freezeValuesSnapshot (setData) {
  return Object.freeze([...setData])
}

function coerceToSet (value) {
  if (value instanceof Set) return new Set(value)
  if (!value || typeof value[Symbol.iterator] !== 'function') {
    throw new TypeError('Set signal expects a Set or iterable of values')
  }
  return new Set(value)
}

function createDerivedSetSignal (compute) {
  const source = createDerivedSignal(track => createSetView(coerceToSet(compute(track))))
  const valueSignals = new Map()
  let index

  function getIndex () {
    if (index) return index

    const values = createStableSnapshotSignal(source, value => freezeValuesSnapshot(value))
    const size = createDerivedSignal(track => track(values).length)

    index = Object.freeze({ values, size })
    return index
  }

  function value (v) {
    if (valueSignals.has(v)) return valueSignals.get(v)

    let previousEntry

    const signal = createDerivedSignal(track => {
      const nextEntry = Object.freeze({ present: track(source).has(v) })

      if (previousEntry && previousEntry.present === nextEntry.present) return previousEntry

      previousEntry = nextEntry
      return previousEntry
    })

    valueSignals.set(v, signal)
    return signal
  }

  return composeSignal({
    getValue: source.getValue,
    value,

    get index () { return getIndex() },

    has: v => source.getValue().has(v),

    get size () { return source.getValue().size }
  }, source)
}

export default function createSetSignal (initialValue) {
  if (arguments.length > 1) throw new TypeError('createSetSignal(initialValue) accepts only one argument')
  if (typeof initialValue === 'function') return createDerivedSetSignal(initialValue)

  let setData = (initialValue === undefined) ? new Set() : coerceToSet(initialValue)
  let valueView = createSetView(setData)

  let index
  let valuesIndex
  let sizeIndex
  let indexValuesValue

  const getValue = () => valueView
  const subscriptions = new SubscriptionManager({ getValue })

  function getIndex () {
    if (index) return index

    const values = freezeValuesSnapshot(setData)
    indexValuesValue = values
    valuesIndex = createIndexSignal(values)
    sizeIndex = createIndexSignal(setData.size)

    index = Object.freeze({
      values: valuesIndex.signal,
      size: sizeIndex.signal
    })

    return index
  }

  function updateIndexValuesIfNeeded (shouldUpdate) {
    if (!index || !shouldUpdate) return

    const values = freezeValuesSnapshot(setData)

    if (indexValuesValue && indexValuesValue.length === values.length) {
      let same = true
      for (let i = 0; i < values.length; i++) {
        if (!Object.is(values[i], indexValuesValue[i])) {
          same = false
          break
        }
      }
      if (same) {
        sizeIndex.setValue(setData.size)
        return
      }
    }

    indexValuesValue = values
    valuesIndex.setValue(values)
    sizeIndex.setValue(setData.size)
  }

  const valueSignals = new Map() // value -> { signal, getEntry, setEntry }

  function freezePresence (value) {
    return Object.freeze({ present: setData.has(value) })
  }

  function updateValueSignal (v) {
    const rec = valueSignals.get(v)
    if (!rec) return

    const previousEntry = rec.getEntry()
    const nextEntry = freezePresence(v)

    if (previousEntry.present === nextEntry.present) return

    rec.setEntry(nextEntry)
  }

  function updateAllValueSignals () {
    for (const [v] of valueSignals) updateValueSignal(v)
  }

  function value (v) {
    if (valueSignals.has(v)) return valueSignals.get(v).signal

    let entry = freezePresence(v)

    const getEntry = () => entry
    const getValue = () => entry

    const subscriptions = new SubscriptionManager({
      getValue,
      onAllSubscriptionsRemoved: () => {
        if (setData.has(v)) return
        const current = valueSignals.get(v)
        current?.signal === signal && valueSignals.delete(v)
      }
    })

    const setEntry = nextEntry => {
      const previousEntry = entry
      entry = nextEntry
      subscriptions.hasSubscribers() && subscriptions.notify(createUpdateChange({ nextValue: nextEntry, previousValue: previousEntry }))
    }

    const signal = composeSignal({ getValue }, subscriptions)

    valueSignals.set(v, { signal, getEntry, setEntry })
    return signal
  }

  function setValue (nextOrUpdater) {
    assertNotInDerivedCompute('set')
    const previousSetData = setData
    const previousValue = valueView

    let nextInput = (typeof nextOrUpdater === 'function')
      ? nextOrUpdater(previousValue)
      : nextOrUpdater

    const nextSetData = coerceToSet(nextInput)

    if (nextSetData.size === previousSetData.size) {
      const prevIter = previousSetData.values()
      const nextIter = nextSetData.values()

      let allSame = true

      while (true) {
        const p = prevIter.next()
        const n = nextIter.next()

        if (p.done && n.done) break
        if (p.done !== n.done || !Object.is(p.value, n.value)) {
          allSame = false
          break
        }
      }

      if (allSame) return false
    }

    setData = nextSetData
    valueView = createSetView(setData)

    const meta = Object.freeze({
      patches: Object.freeze([Object.freeze({ op: 'replace', values: freezeValuesSnapshot(setData) })]),
      inversePatches: Object.freeze([Object.freeze({ op: 'replace', values: freezeValuesSnapshot(previousSetData) })])
    })

    subscriptions.notify(createUpdateChange({ nextValue: valueView, previousValue, meta }))
    updateIndexValuesIfNeeded(true)
    updateAllValueSignals()

    return true
  }

  function mutate (fn) {
    assertNotInDerivedCompute('mutate')
    if (typeof fn !== 'function') throw new TypeError('Set signal mutate(fn) expects fn to be a function')

    const previousValue = valueView

    const working = new Set(setData)
    const changedValues = new Set()

    const patches = []
    const inversePatches = []

    function recordAdd (v) {
      if (working.has(v)) return false

      working.add(v)
      changedValues.add(v)

      patches.push(Object.freeze({ op: 'add', value: v }))
      inversePatches.unshift(Object.freeze({ op: 'delete', value: v }))

      return true
    }

    function recordDelete (v) {
      if (!working.has(v)) return false

      working.delete(v)
      changedValues.add(v)

      patches.push(Object.freeze({ op: 'delete', value: v }))
      inversePatches.unshift(Object.freeze({ op: 'add', value: v }))

      return true
    }

    function recordClear () {
      if (working.size === 0) return false

      const previousValues = freezeValuesSnapshot(working)

      for (const v of working) changedValues.add(v)
      working.clear()

      patches.push(Object.freeze({ op: 'clear' }))
      inversePatches.unshift(Object.freeze({ op: 'replace', values: previousValues }))

      return true
    }

    const mutators = Object.freeze({
      get size () { return working.size },

      has: v => working.has(v),

      add: v => recordAdd(v),
      delete: v => recordDelete(v),
      clear: () => recordClear(),

      values: () => working.values(),
      keys: () => working.keys(),
      entries: () => working.entries()
    })

    fn(mutators)

    if (patches.length === 0) return null

    setData = working
    valueView = createSetView(setData)

    Object.freeze(patches)
    Object.freeze(inversePatches)

    const meta = Object.freeze({ patches, inversePatches })

    subscriptions.notify(createUpdateChange({ nextValue: valueView, previousValue, meta }))

    updateIndexValuesIfNeeded(true)

    for (const v of changedValues) updateValueSignal(v)

    return Object.freeze({
      patches: Object.freeze(patches.slice()),
      inversePatches: Object.freeze(inversePatches.slice())
    })
  }

  return composeSignal({
    getValue,
    setValue,
    mutate,
    value,

    get index () { return getIndex() },

    has: v => setData.has(v),

    get size () { return setData.size }
  }, subscriptions)
}
