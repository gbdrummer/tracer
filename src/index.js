import createSignal from './core/createSignal.js'
import createArraySignal from './collections/createArraySignal.js'
import createObjectSignal from './collections/createObjectSignal.js'
import createMapSignal from './collections/createMapSignal.js'
import createSetSignal from './collections/createSetSignal.js'
import createDerivedSignal from './core/createDerivedSignal.js'

export { default as overridable } from './core/overridable.js'
export { batch } from './core/queue.js'
export { default as TracerSignal } from './core/TracerSignal.js'
export { SIGNAL_BRAND } from './core/constants.js'
export { isSignal } from './core/utilities.js'

export function signal (initialValue) {
  if (arguments.length > 1) throw new TypeError('signal() accepts only one argument')

  if (typeof initialValue === 'function') return createDerivedSignal(initialValue)
  return createSignal(initialValue)
}

Object.defineProperties(signal, {
  array: {
    value: initialValue => createArraySignal(initialValue)
  },

  object: {
    value: initialValue => createObjectSignal(initialValue)
  },

  map: {
    value: initialValue => createMapSignal(initialValue)
  },

  set: {
    value: initialValue => createSetSignal(initialValue)
  }
})
