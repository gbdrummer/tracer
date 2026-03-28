import SubscriptionManager from './SubscriptionManager.js'
import { createUpdateChange } from './change.js'
import { assertNotInDerivedCompute, composeSignal } from './utilities.js'

export default function createSignal (initialValue) {
  let value = initialValue

  const getValue = () => value,
        subscriptions = new SubscriptionManager({ getValue })

  return composeSignal({
    getValue,

    setValue: nextValue => {
      assertNotInDerivedCompute('set')
      const previousValue = value

      nextValue = (typeof nextValue === 'function')
        ? nextValue(previousValue)
        : nextValue

      if (Object.is(previousValue, nextValue)) return false
      
      value = nextValue
      subscriptions.notify(createUpdateChange({ nextValue, previousValue }))
      return true
    }
  }, subscriptions)
}