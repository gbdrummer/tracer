import SubscriptionManager from './SubscriptionManager.js'
import { createUpdateChange } from './change.js'

import { assertNotInDerivedCompute, composeSignal, isSignal } from './utilities.js'

export default function overridable (base) {
  if (!isSignal(base)) {
    const tag = Object.prototype.toString.call(base)
    const constructorName = base?.constructor?.name
    const constructorInfo = constructorName ? ` (${constructorName})` : ''
    throw new TypeError(`overridable(base) expected TracerSignal instance, received ${tag}${constructorInfo}.`)
  }

  let isOverridden = false
  let overrideValue
  let latestValue

  let baseUnsubscribe

  const getValue = () => {
    if (isOverridden) return overrideValue

    if (!subscriptions.hasSubscribers()) return base.getValue()

    return latestValue
  }

  const subscriptions = new SubscriptionManager({
    getValue,

    onFirstSubscription: () => {
      if (isOverridden) {
        latestValue = overrideValue
        return
      }

      latestValue = base.getValue()
      subscribeToBase()
    },

    onAllSubscriptionsRemoved: () => {
      unsubscribeFromBase()
    }
  })

  function subscribeToBase () {
    if (baseUnsubscribe) return

    baseUnsubscribe = base.subscribe(change => {
      if (change.kind === 'init') return
      handleBaseChange()
    })
  }

  function unsubscribeFromBase () {
    if (!baseUnsubscribe) return
    baseUnsubscribe()
    baseUnsubscribe = undefined
  }

  function handleBaseChange () {
    if (isOverridden) return
    if (!subscriptions.hasSubscribers()) return

    const previousValue = latestValue
    const nextValue = base.getValue()

    if (Object.is(previousValue, nextValue)) return

    latestValue = nextValue
    subscriptions.notify(createUpdateChange({ nextValue, previousValue }))
  }

  function setValue (nextOrUpdater) {
    assertNotInDerivedCompute('set')
    const previousValue = getValue()

    const nextValue = (typeof nextOrUpdater === 'function')
      ? nextOrUpdater(previousValue)
      : nextOrUpdater

    const changed = !Object.is(previousValue, nextValue)

    isOverridden = true
    overrideValue = nextValue
    latestValue = nextValue

    unsubscribeFromBase()

    if (!changed) return false
    subscriptions.hasSubscribers() && subscriptions.notify(createUpdateChange({ nextValue, previousValue }))
    return true
  }

  function clear () {
    assertNotInDerivedCompute('clear')
    if (!isOverridden) return false

    const previousValue = overrideValue

    isOverridden = false
    overrideValue = undefined

    const nextValue = base.getValue()
    latestValue = nextValue

    subscriptions.hasSubscribers() && subscribeToBase()

    if (Object.is(previousValue, nextValue)) return false
    subscriptions.hasSubscribers() && subscriptions.notify(createUpdateChange({ nextValue, previousValue }))
    return true
  }

  return composeSignal({
    getValue,
    setValue,
    clear,

    get isOverridden () {
      return isOverridden
    }
  }, subscriptions)
}
