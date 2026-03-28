import SubscriptionManager from './SubscriptionManager.js'
import { createUpdateChange } from './change.js'
import { composeSignal, enterDerivedCompute, exitDerivedCompute, isSignal } from './utilities.js'

export default function createDerivedSignal (compute) {
  let latestValue, isRecomputing = false

  // Upstream dependency subscriptions while hot
  const dependencyUnsubscribers = new Map // dependency -> unsubscribe()

  const getValue = () => {
    // Cold: recompute on read (no upstream subscriptions held)
    !subscriptions.hasSubscribers() && recompute(false)
    return latestValue
  }

  const subscriptions = new SubscriptionManager({
    getValue,

    // Prime + establish dependency subscriptions
    onFirstSubscription: () => recompute(true),

    // Go cold: drop upstream subscriptions, force cold reads to recompute
    onAllSubscriptionsRemoved: () => unsubscribeAll()
  })

  function invalidateFromUpstream () {
    if (!subscriptions.hasSubscribers()) return

    // Hot mode: recompute eagerly on invalidation so getValue stays pure.
    // Notify downstream only if value actually changes.
    const previousValue = latestValue
    recompute(true)
    const nextValue = latestValue

    !Object.is(previousValue, nextValue) && subscriptions.notify(createUpdateChange({ nextValue, previousValue }))
  }

  function recompute (shouldSubscribeDependencies) {
    if (isRecomputing) throw new Error('Derived signal recompute() re-entered')

    isRecomputing = true
    const nextDependencies = new Set

    const track = dependency => {
      if (!isSignal(dependency)) {
        const tag = Object.prototype.toString.call(dependency),
              constructorName = dependency?.constructor?.name,
              constructorInfo = constructorName ? ` (${constructorName})` : ''

        throw new TypeError(`Derived signal expected TracerSignal instance as dependency, received ${tag}${constructorInfo}.`)
      }

      nextDependencies.add(dependency)
      return dependency.getValue()
    }

    enterDerivedCompute()
    try {
      latestValue = compute(track)
      syncDependencies(nextDependencies, shouldSubscribeDependencies)
    } finally {
      exitDerivedCompute()
      isRecomputing = false
    }
  }

  function subscribeDependency (dependency, cb) {
    return dependency.subscribe(change => {
      if (change.kind === 'init') return
      cb(change)
    })
  }

  function syncDependencies (nextDependencies, shouldSubscribe) {
    // prune removed dependencies
    for (const [dependency, unsubscribe] of dependencyUnsubscribers) {
      if (!nextDependencies.has(dependency)) {
        unsubscribe()
        dependencyUnsubscribers.delete(dependency)
      }
    }

    if (!shouldSubscribe) return

    // store new dependencies
    for (const dependency of nextDependencies) {
      if (dependencyUnsubscribers.has(dependency)) continue
      dependencyUnsubscribers.set(dependency, subscribeDependency(dependency, invalidateFromUpstream))
    }
  }

  function unsubscribeAll () {
    // Should we cache dependencyUnsubscribers before clearing?
    for (const [, unsubscribe] of dependencyUnsubscribers) unsubscribe()
    dependencyUnsubscribers.clear()
  }

  return composeSignal({ getValue }, subscriptions)
}