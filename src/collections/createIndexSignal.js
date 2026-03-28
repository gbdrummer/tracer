import SubscriptionManager from '../core/SubscriptionManager.js'
import { createUpdateChange } from '../core/change.js'
import { composeSignal } from '../core/utilities.js'

export default function createIndexSignal (initialValue) {
  let value = initialValue

  const getValue = () => value
  const subscriptions = new SubscriptionManager({ getValue })

  const signal = composeSignal({ getValue }, subscriptions)

  function setValue (nextValue) {
    const previousValue = value
    if (Object.is(previousValue, nextValue)) return false

    value = nextValue

    subscriptions.hasSubscribers() && subscriptions.notify(createUpdateChange({ nextValue, previousValue }))
    return true
  }

  return Object.freeze({ signal, setValue })
}
