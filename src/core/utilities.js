import { SIGNAL_BRAND } from './constants.js'

let derivedComputeDepth = 0

export function enterDerivedCompute () {
  derivedComputeDepth++
}

export function exitDerivedCompute () {
  derivedComputeDepth--
}

export function assertNotInDerivedCompute (action = 'update') {
  if (derivedComputeDepth === 0) return
  throw new Error(`Reentrancy guard: cannot ${action} signal value during derived computation`)
}

export function composeSignal (signalObj, subscriptions) {
  return Object.defineProperties(signalObj, {
    [SIGNAL_BRAND]: { get: () => true },
    [Symbol.toStringTag]: { get: () => Symbol.keyFor(SIGNAL_BRAND) },
    
    subscribe: {
      value: cb => subscriptions.subscribe(cb)
    }
  })
}

export function isSignal (v) {
  return !!v && v[SIGNAL_BRAND] === true
}