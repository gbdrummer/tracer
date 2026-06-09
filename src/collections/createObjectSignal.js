import SubscriptionManager from '../core/SubscriptionManager.js'
import { createUpdateChange } from '../core/change.js'
import createDerivedSignal from '../core/createDerivedSignal.js'
import createIndexSignal from './createIndexSignal.js'
import { createStableSnapshotSignal } from './utilities.js'
import { assertNotInDerivedCompute, composeSignal } from '../core/utilities.js'

function freezeObjectValue (value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${context} expects value to be an object`)
  return Object.freeze({ ...value })
}

function createDerivedObjectSignal (compute) {
  const source = createDerivedSignal(track => freezeObjectValue(compute(track), 'Derived object signal compute(track)'))
  let index

  function getIndex () {
    if (index) return index

    const keys = createStableSnapshotSignal(source, value => Object.keys(value))
    const size = createDerivedSignal(track => track(keys).length)

    index = Object.freeze({ keys, size })
    return index
  }

  return composeSignal({
    getValue: source.getValue,

    get index () { return getIndex() }
  }, source)
}

export default function createObjectSignal (initialValue) {
  if (typeof initialValue === 'function') return createDerivedObjectSignal(initialValue)

  let value = freezeObjectValue(initialValue, 'createObjectSignal(initialValue)')

  let index
  let keysIndex
  let sizeIndex
  let indexKeysValue

  const getValue = () => value
  const subscriptions = new SubscriptionManager({ getValue })

  function getIndex () {
    if (index) return index

    const keys = Object.freeze(Object.keys(value))
    indexKeysValue = keys
    keysIndex = createIndexSignal(keys)
    sizeIndex = createIndexSignal(keys.length)

    index = Object.freeze({
      keys: keysIndex.signal,
      size: sizeIndex.signal
    })

    return index
  }

  function updateIndexKeysIfNeeded (shouldUpdate) {
    if (!index || !shouldUpdate) return

    const keys = Object.freeze(Object.keys(value))

    if (indexKeysValue && indexKeysValue.length === keys.length) {
      let same = true
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] !== indexKeysValue[i]) {
          same = false
          break
        }
      }
      if (same) return
    }

    indexKeysValue = keys
    keysIndex.setValue(keys)
    sizeIndex.setValue(keys.length)
  }

  function setValue (nextOrUpdater) {
    assertNotInDerivedCompute('set')
    const previousValue = value

    let nextValue = (typeof nextOrUpdater === 'function')
      ? nextOrUpdater(previousValue)
      : nextOrUpdater

    if (!nextValue || typeof nextValue !== 'object' || Array.isArray(nextValue)) throw new TypeError('Object signal setValue(next) expects next to be an object')

    nextValue = Object.freeze({ ...nextValue })

    if (Object.is(previousValue, nextValue)) return false

    value = nextValue

    updateIndexKeysIfNeeded(true)

    const meta = Object.freeze({
      patches: Object.freeze([Object.freeze({ op: 'replace', value: nextValue })]),
      inversePatches: Object.freeze([Object.freeze({ op: 'replace', value: previousValue })])
    })

    subscriptions.notify(createUpdateChange({ nextValue, previousValue, meta }))

    return true
  }

  function mutate (fn) {
    assertNotInDerivedCompute('mutate')
    if (typeof fn !== 'function') throw new TypeError('Object signal mutate(fn) expects fn to be a function')

    const previousValue = value
    const working = { ...previousValue }

    const patches = []
    const inversePatches = []

    let didChangeKeys = false

    function recordSet (key, next) {
      if (typeof key !== 'string') throw new TypeError('mutators.set(key, value) expects key to be a string')

      const hadKey = Object.prototype.hasOwnProperty.call(working, key)
      const previous = working[key]

      if (hadKey && Object.is(previous, next)) return false

      working[key] = next
      patches.push(Object.freeze({ op: 'set', key, value: next }))

      if (!hadKey) didChangeKeys = true

      if (hadKey) {
        inversePatches.unshift(Object.freeze({ op: 'set', key, value: previous }))
      } else {
        inversePatches.unshift(Object.freeze({ op: 'delete', key }))
      }

      return true
    }

    function recordDelete (key) {
      if (typeof key !== 'string') throw new TypeError('mutators.delete(key) expects key to be a string')

      if (!Object.prototype.hasOwnProperty.call(working, key)) return false

      const previous = working[key]
      delete working[key]

      didChangeKeys = true

      patches.push(Object.freeze({ op: 'delete', key }))
      inversePatches.unshift(Object.freeze({ op: 'set', key, value: previous }))

      return true
    }

    const mutators = Object.freeze({
      has: key => Object.prototype.hasOwnProperty.call(working, key),

      get: key => working[key],

      set: (key, next) => recordSet(key, next),

      delete: key => recordDelete(key),

      assign: partial => {
        if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw new TypeError('mutators.assign(obj) expects obj to be an object')

        let changed = false
        for (const key of Object.keys(partial)) {
          changed = recordSet(key, partial[key]) || changed
        }

        return changed
      }
    })

    fn(mutators)

    if (patches.length === 0) return null

    const nextValue = Object.freeze({ ...working })
    value = nextValue

    updateIndexKeysIfNeeded(didChangeKeys)

    const meta = {
      patches,
      inversePatches
    }

    Object.freeze(patches)
    Object.freeze(inversePatches)
    Object.freeze(meta)

    subscriptions.notify(createUpdateChange({ nextValue, previousValue, meta }))

    return Object.freeze({
      patches: Object.freeze(patches.slice()),
      inversePatches: Object.freeze(inversePatches.slice())
    })
  }

  return composeSignal({
    getValue,
    setValue,
    mutate,

    get index () { return getIndex() }
  }, subscriptions)
}
