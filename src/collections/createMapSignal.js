import SubscriptionManager from '../core/SubscriptionManager.js'
import { createUpdateChange } from '../core/change.js'
import createIndexSignal from './createIndexSignal.js'
import { assertNotInDerivedCompute, composeSignal } from '../core/utilities.js'

function createMapView (mapData) {
  const view = {
    get size () { return mapData.size },

    has: key => mapData.has(key),
    get: key => mapData.get(key),

    keys: () => mapData.keys(),
    values: () => mapData.values(),
    entries: () => mapData.entries(),

    forEach: (cb, thisArg) => {
      if (typeof cb !== 'function') throw new TypeError('Map view forEach(cb, thisArg) expects cb to be a function')
      mapData.forEach((value, key) => cb.call(thisArg, value, key, view))
    },

    [Symbol.iterator]: () => mapData[Symbol.iterator]()
  }

  return Object.freeze(view)
}

function freezeEntry (key, mapData) {
  const present = mapData.has(key)
  const value = present ? mapData.get(key) : undefined
  return Object.freeze({ present, value })
}

function freezeEntriesSnapshot (mapData) {
  const out = []
  for (const [key, value] of mapData) out.push(Object.freeze([key, value]))
  return Object.freeze(out)
}

function coerceToMap (value) {
  if (value instanceof Map) return new Map(value)
  if (!value || typeof value[Symbol.iterator] !== 'function') {
    throw new TypeError('Map signal expects a Map or iterable of [key, value] entries')
  }
  return new Map(value)
}

export default function createMapSignal (initialValue) {
  if (arguments.length > 1) throw new TypeError('createMapSignal(initialValue) accepts only one argument')

  let mapData = (initialValue === undefined) ? new Map() : coerceToMap(initialValue)
  let valueView = createMapView(mapData)

  let index
  let keysIndex
  let sizeIndex
  let indexKeysValue

  const getValue = () => valueView
  const subscriptions = new SubscriptionManager({ getValue })

  function freezeKeysSnapshot (m) {
    return Object.freeze([...m.keys()])
  }

  function getIndex () {
    if (index) return index

    const keys = freezeKeysSnapshot(mapData)
    indexKeysValue = keys
    keysIndex = createIndexSignal(keys)
    sizeIndex = createIndexSignal(mapData.size)

    index = Object.freeze({
      keys: keysIndex.signal,
      size: sizeIndex.signal
    })

    return index
  }

  function updateIndexKeysIfNeeded (shouldUpdate) {
    if (!index || !shouldUpdate) return

    const keys = freezeKeysSnapshot(mapData)

    if (indexKeysValue && indexKeysValue.length === keys.length) {
      let same = true
      for (let i = 0; i < keys.length; i++) {
        if (!Object.is(keys[i], indexKeysValue[i])) {
          same = false
          break
        }
      }
      if (same) {
        sizeIndex.setValue(mapData.size)
        return
      }
    }

    indexKeysValue = keys
    keysIndex.setValue(keys)
    sizeIndex.setValue(mapData.size)
  }

  const keySignals = new Map() // key -> { signal, setEntry(entry) }

  function updateKeySignal (key) {
    const rec = keySignals.get(key)
    if (!rec) return

    const previousEntry = rec.getEntry()
    const nextEntry = freezeEntry(key, mapData)

    if (previousEntry.present === nextEntry.present && Object.is(previousEntry.value, nextEntry.value)) return

    rec.setEntry(nextEntry)
  }

  function updateAllKeySignals () {
    for (const [key] of keySignals) updateKeySignal(key)
  }

  function key (k) {
    if (keySignals.has(k)) return keySignals.get(k).signal

    let entry = freezeEntry(k, mapData)

    const getEntry = () => entry
    const getValue = () => entry
    const subscriptions = new SubscriptionManager({
      getValue,
      onAllSubscriptionsRemoved: () => {
        if (mapData.has(k)) return
        const current = keySignals.get(k)
        current?.signal === signal && keySignals.delete(k)
      }
    })

    const setEntry = nextEntry => {
      const previousEntry = entry
      entry = nextEntry
      subscriptions.hasSubscribers() && subscriptions.notify(createUpdateChange({ nextValue: nextEntry, previousValue: previousEntry }))
    }

    const signal = composeSignal({ getValue }, subscriptions)

    keySignals.set(k, { signal, getEntry, setEntry })
    return signal
  }

  function setValue (nextOrUpdater) {
    assertNotInDerivedCompute('set')
    const previousMapData = mapData
    const previousValue = valueView

    let nextInput = (typeof nextOrUpdater === 'function')
      ? nextOrUpdater(previousValue)
      : nextOrUpdater

    const nextMapData = coerceToMap(nextInput)

    let didChangeKeys = nextMapData.size !== previousMapData.size

    if (!didChangeKeys && nextMapData.size === previousMapData.size) {
      const prevIter = previousMapData.entries()
      const nextIter = nextMapData.entries()

      let allSame = true

      while (true) {
        const p = prevIter.next()
        const n = nextIter.next()

        if (p.done && n.done) break
        if (p.done !== n.done) {
          allSame = false
          didChangeKeys = true
          break
        }

        const [pk, pv] = p.value
        const [nk, nv] = n.value

        if (!Object.is(pk, nk)) {
          allSame = false
          didChangeKeys = true
          break
        }

        if (!Object.is(pv, nv)) {
          allSame = false
        }
      }

      if (allSame) return false
    }

    mapData = nextMapData
    valueView = createMapView(mapData)

    const meta = Object.freeze({
      patches: Object.freeze([Object.freeze({ op: 'replace', entries: freezeEntriesSnapshot(mapData) })]),
      inversePatches: Object.freeze([Object.freeze({ op: 'replace', entries: freezeEntriesSnapshot(previousMapData) })])
    })

    subscriptions.notify(createUpdateChange({ nextValue: valueView, previousValue, meta }))

    updateIndexKeysIfNeeded(didChangeKeys)
    updateAllKeySignals()

    return true
  }

  function mutate (fn) {
    assertNotInDerivedCompute('mutate')
    if (typeof fn !== 'function') throw new TypeError('Map signal mutate(fn) expects fn to be a function')

    const previousMapData = mapData
    const previousValue = valueView

    const working = new Map(previousMapData)
    const changedKeys = new Set()

    let didChangeKeys = false

    const patches = []
    const inversePatches = []

    function recordSet (key, value) {
      const had = working.has(key)
      const previous = working.get(key)

      if (had && Object.is(previous, value)) return false

      working.set(key, value)
      changedKeys.add(key)

      if (!had) didChangeKeys = true

      patches.push(Object.freeze({ op: 'set', key, value }))

      if (had) inversePatches.unshift(Object.freeze({ op: 'set', key, value: previous }))
      else inversePatches.unshift(Object.freeze({ op: 'delete', key }))

      return true
    }

    function recordDelete (key) {
      if (!working.has(key)) return false

      const previous = working.get(key)
      working.delete(key)
      changedKeys.add(key)

      didChangeKeys = true

      patches.push(Object.freeze({ op: 'delete', key }))
      inversePatches.unshift(Object.freeze({ op: 'set', key, value: previous }))

      return true
    }

    function recordClear () {
      if (working.size === 0) return false

      const prevEntries = freezeEntriesSnapshot(working)

      for (const k of working.keys()) changedKeys.add(k)
      working.clear()

      didChangeKeys = true

      patches.push(Object.freeze({ op: 'clear' }))
      inversePatches.unshift(Object.freeze({ op: 'replace', entries: prevEntries }))

      return true
    }

    const mutators = Object.freeze({
      get size () { return working.size },

      has: key => working.has(key),
      get: key => working.get(key),

      set: (key, value) => recordSet(key, value),
      delete: key => recordDelete(key),
      clear: () => recordClear(),

      entries: () => working.entries(),
      keys: () => working.keys(),
      values: () => working.values()
    })

    fn(mutators)

    if (patches.length === 0) return null

    mapData = working
    valueView = createMapView(mapData)

    Object.freeze(patches)
    Object.freeze(inversePatches)

    const meta = Object.freeze({
      patches,
      inversePatches
    })

    subscriptions.notify(createUpdateChange({ nextValue: valueView, previousValue, meta }))

    updateIndexKeysIfNeeded(didChangeKeys)

    for (const k of changedKeys) updateKeySignal(k)

    return Object.freeze({
      patches: Object.freeze(patches.slice()),
      inversePatches: Object.freeze(inversePatches.slice())
    })
  }

  return composeSignal({
    getValue,
    setValue,
    mutate,
    key,

    get index () { return getIndex() },

    has: key => mapData.has(key),
    get: key => mapData.get(key),

    get size () { return mapData.size }
  }, subscriptions)
}
