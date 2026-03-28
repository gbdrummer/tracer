import { isBatching, enqueue } from './queue.js'
import { createInitChange, normalizeChange, createBatchedChangeAccumulator } from './change.js'

export default function SubscriptionManager ({ getValue, onFirstSubscription, onAllSubscriptionsRemoved } = {}) {
  const subscriptions = new Set,
        batchKey = {}

  let hasPendingNotify = false
  const accumulator = createBatchedChangeAccumulator()

  function notifyNow (change) {
    if (subscriptions.size === 0) return

    const snapshot = [...subscriptions]
    let firstError

    for (const fn of snapshot) {
      if (!subscriptions.has(fn)) continue

      try {
        fn(change)
      } catch (err) {
        firstError ??= err
      }
    }

    if (firstError) throw firstError
  }

  function removeSubscription (cb) {
    if (!subscriptions.delete(cb)) return false
    subscriptions.size === 0 && onAllSubscriptionsRemoved?.()
    return true
  }

  return Object.defineProperties(this, {
    hasSubscribers: {
      value: () => subscriptions.size > 0
    },

    subscribe: {
      value: cb => {
        const wasEmpty = subscriptions.size === 0
        subscriptions.add(cb)
        
        try {
          wasEmpty && onFirstSubscription?.()
          cb(createInitChange({ nextValue: getValue() }))
        } catch (err) {
          removeSubscription(cb)
          throw err
        }

        return () => removeSubscription(cb)
      }
    },

    notify: {
      value: change => {
        change = normalizeChange(change)
 
        if (!isBatching()) return notifyNow(change)

        if (!hasPendingNotify) {
          hasPendingNotify = true
          accumulator.reset(change)

          enqueue(batchKey, () => {
            hasPendingNotify = false
            notifyNow(accumulator.flush())
          })

          return
        }

        accumulator.push(change)
      }
    }
  })
}