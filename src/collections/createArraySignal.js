import SubscriptionManager from '../core/SubscriptionManager.js'
import { createUpdateChange } from '../core/change.js'
import createDerivedSignal from '../core/createDerivedSignal.js'
import createIndexSignal from './createIndexSignal.js'
import { assertNotInDerivedCompute, composeSignal } from '../core/utilities.js'

function freezeArrayValue (value, context) {
  if (!Array.isArray(value)) throw new TypeError(`${context} expects value to be an array`)
  return Object.freeze(value.slice())
}

function createLengthSignal (source) {
  return createDerivedSignal(track => track(source).length)
}

function createDerivedArraySignal (compute) {
  const source = createDerivedSignal(track => freezeArrayValue(compute(track), 'Derived array signal compute(track)'))
  let index

  function getIndex () {
    if (index) return index

    index = Object.freeze({
      length: createLengthSignal(source)
    })

    return index
  }

  return composeSignal({
    getValue: source.getValue,

    get index () { return getIndex() }
  }, source)
}

export default function createArraySignal (initialValue) {
  if (typeof initialValue === 'function') return createDerivedArraySignal(initialValue)

  let value = freezeArrayValue(initialValue, 'createArraySignal(initialValue)')

  let index
  let lengthIndex

  const getValue = () => value
  const subscriptions = new SubscriptionManager({ getValue })

  function getIndex () {
    if (index) return index

    lengthIndex = createIndexSignal(value.length)
    index = Object.freeze({
      length: lengthIndex.signal
    })

    return index
  }

  function updateLengthIndex (previousValue, nextValue) {
    if (!lengthIndex) return
    lengthIndex.setValue(nextValue.length)
  }

  function setValue (nextOrUpdater) {
    assertNotInDerivedCompute('set')
    const previousValue = value

    let nextValue = (typeof nextOrUpdater === 'function')
      ? nextOrUpdater(previousValue)
      : nextOrUpdater

    if (!Array.isArray(nextValue)) throw new TypeError('Array signal setValue(next) expects next to be an array')

    nextValue = Object.freeze(nextValue.slice())

    if (Object.is(previousValue, nextValue)) return false

    value = nextValue
    updateLengthIndex(previousValue, nextValue)

    const meta = Object.freeze({
      patches: Object.freeze([Object.freeze({ op: 'replace', value: nextValue })]),
      inversePatches: Object.freeze([Object.freeze({ op: 'replace', value: previousValue })])
    })

    subscriptions.notify(createUpdateChange({ nextValue, previousValue, meta }))

    return true
  }

  function mutate (fn) {
    assertNotInDerivedCompute('mutate')
    if (typeof fn !== 'function') throw new TypeError('Array signal mutate(fn) expects fn to be a function')

    const previousValue = value
    const working = previousValue.slice()

    const patches = []
    const inversePatches = []

    function recordSet (index, next) {
      const previous = working[index]
      if (Object.is(previous, next)) return false

      working[index] = next

      patches.push(Object.freeze({ op: 'set', index, value: next }))
      inversePatches.unshift(Object.freeze({ op: 'set', index, value: previous }))
      return true
    }

    function recordSplice (index, deleteCount, items) {
      const removed = working.slice(index, index + deleteCount)
      working.splice(index, deleteCount, ...items)

      patches.push(Object.freeze({ op: 'splice', index, deleteCount, items: Object.freeze(items.slice()) }))
      inversePatches.unshift(Object.freeze({ op: 'splice', index, deleteCount: items.length, items: Object.freeze(removed) }))
      return removed
    }

    const mutators = Object.freeze({
      get length () { return working.length },

      push: (...items) => {
        recordSplice(working.length, 0, items)
        return working.length
      },

      pop: () => {
        if (working.length === 0) return undefined
        const removed = recordSplice(working.length - 1, 1, [])
        return removed[0]
      },

      unshift: (...items) => {
        recordSplice(0, 0, items)
        return working.length
      },

      shift: () => {
        if (working.length === 0) return undefined
        const removed = recordSplice(0, 1, [])
        return removed[0]
      },

      splice: (start, deleteCount = working.length - start, ...items) => {
        start = start < 0 ? Math.max(working.length + start, 0) : Math.min(start, working.length)
        deleteCount = Math.max(0, Math.min(deleteCount, working.length - start))
        return recordSplice(start, deleteCount, items)
      },

      set: (index, next) => {
        if (!Number.isInteger(index)) throw new TypeError('mutators.set(index, value) expects index to be an integer')
        if (index < 0 || index >= working.length) throw new RangeError('mutators.set(index, value) index out of range')
        return recordSet(index, next)
      }
    })

    fn(mutators)

    if (patches.length === 0) return null

    const nextValue = Object.freeze(working)
    value = nextValue

    updateLengthIndex(previousValue, nextValue)

    const meta = Object.freeze({
      patches: Object.freeze(patches),
      inversePatches: Object.freeze(inversePatches)
    })

    subscriptions.notify(createUpdateChange({ nextValue, previousValue, meta }))

    const bundle = Object.freeze({
      patches: Object.freeze(patches.slice()),
      inversePatches: Object.freeze(inversePatches.slice())
    })

    return bundle
  }

  return composeSignal({
    getValue,
    setValue,
    mutate,

    get index () { return getIndex() }
  }, subscriptions)
}
