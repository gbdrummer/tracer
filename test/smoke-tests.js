import { signal, overridable, batch } from '../src/index.js'
import createHistory from '../src/history/index.js'
import TracerSignal from '../src/core/TracerSignal.js'
import { SIGNAL_BRAND } from '../src/core/constants.js'
import SubscriptionManager from '../src/core/SubscriptionManager.js'
import { createUpdateChange } from '../src/core/change.js'

export function runSmokeTests () {
  const results = { pass: 0, fail: 0 }

  const STRESS = (
    (typeof process !== 'undefined' && process?.env?.TRACER_STRESS === '1') ||
    globalThis.TRACER_STRESS === true
  )

  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }

  const assertEqual = (actual, expected, message) => {
    if (!Object.is(actual, expected)) {
      throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`)
    }
  }

  const assertThrows = (fn, predicate, message) => {
    if (arguments.length === 2) {
      message = predicate
      predicate = undefined
    }

    let thrown = null
    try {
      fn()
    } catch (err) {
      thrown = err
    }

    if (!thrown) throw new Error(message)

    if (typeof predicate === 'function') {
      assert(predicate(thrown), message)
    } else if (predicate instanceof RegExp) {
      assert(predicate.test(String(thrown?.message ?? thrown)), message)
    }
  }

  const test = (name, fn) => {
    try {
      fn()
      results.pass++
      console.log('PASS', name)
    } catch (err) {
      results.fail++
      console.error('FAIL', name)
      console.error(err)
    }
  }

  const defineBrand = obj => Object.defineProperties(obj, {
    [SIGNAL_BRAND]: { get: () => true },
    [Symbol.toStringTag]: { get: () => Symbol.keyFor(SIGNAL_BRAND) }
  })

  const createSpySignal = initialValue => {
    let value = initialValue
    let activeSubscribers = 0
    const getValue = () => value
    const subscriptions = new SubscriptionManager({ getValue })

    const subscribe = cb => {
      activeSubscribers++
      let unsubscribed = false
      const unsubscribe = subscriptions.subscribe(cb)
      return () => {
        if (unsubscribed) return
        unsubscribed = true
        activeSubscribers--
        unsubscribe()
      }
    }

    const setValue = nextOrUpdater => {
      const previousValue = value
      const nextValue = (typeof nextOrUpdater === 'function')
        ? nextOrUpdater(previousValue)
        : nextOrUpdater

      if (Object.is(previousValue, nextValue)) return false
      value = nextValue
      subscriptions.notify(createUpdateChange({ nextValue, previousValue }))
      return true
    }

    return defineBrand({
      getValue,
      setValue,
      subscribe,
      get activeSubscriberCount () { return activeSubscribers }
    })
  }

  const stress = (name, fn) => {
    if (!STRESS) return
    test(`stress: ${name}`, fn)
  }

  test('branding: instanceof TracerSignal', () => {
    const stored = signal(0)
    const derived = signal(track => track(stored))
    assert(stored instanceof TracerSignal, 'stored signal should be instanceof TracerSignal')
    assert(derived instanceof TracerSignal, 'derived signal should be instanceof TracerSignal')
  })

  stress('subscriber fanout (5k)', () => {
    const N = 5000
    const s = signal(0)
    let calls = 0

    const unsubs = []
    for (let i = 0; i < N; i++) {
      unsubs.push(s.subscribe(change => {
        if (change.kind === 'init') return
        calls++
      }))
    }

    s.setValue(1)
    assertEqual(calls, N, 'all subscribers should receive the update')

    for (const u of unsubs) u()
  })

  stress('subscribe/unsubscribe churn (10k)', () => {
    const N = 10000
    const s = signal(0)

    for (let i = 0; i < N; i++) {
      const u = s.subscribe(() => {})
      u()
    }

    assertEqual(s.getValue(), 0, 'signal should remain usable after churn')
  })

  stress('derived chain subscribe + teardown (depth 500)', () => {
    const base = createSpySignal(0)
    let current = signal(track => track(base))

    for (let i = 0; i < 500; i++) {
      const prev = current
      current = signal(track => track(prev) + 1)
    }

    const unsub = current.subscribe(() => {})
    assertEqual(base.activeSubscriberCount, 1, 'subscribing to tail should make base hot')

    base.setValue(1)
    assertEqual(current.getValue(), 1 + 500, 'tail value should update after base change')

    unsub()
    assertEqual(base.activeSubscriberCount, 0, 'unsubscribing tail should tear down base subscription')
  })

  stress('derived fanout batched update (1k derived)', () => {
    const base = signal(0)
    const deriveds = []
    const counts = new Array(1000).fill(0)
    const unsubs = []

    for (let i = 0; i < 1000; i++) {
      const d = signal(track => track(base) + i)
      deriveds.push(d)
      unsubs.push(d.subscribe(change => {
        if (change.kind === 'init') return
        counts[i]++
      }))
    }

    batch(() => {
      for (let i = 0; i < 50; i++) base.setValue(i)
    })

    for (let i = 0; i < 1000; i++) {
      if (counts[i] !== 1) throw new Error('each derived should notify exactly once for batched base updates')
    }

    for (const u of unsubs) u()
    assertEqual(deriveds[0].getValue(), base.getValue() + 0, 'deriveds should still be readable after unsubscribe')
  })

  stress('map key signals scaling (2k keys, 1k updates)', () => {
    const m = signal.map()
    const unsubs = []
    const calls = new Array(2000).fill(0)

    for (let i = 0; i < 2000; i++) {
      const k = m.key(i)
      unsubs.push(k.subscribe(change => {
        if (change.kind === 'init') return
        calls[i]++
      }))
    }

    m.mutate(mm => {
      for (let i = 0; i < 1000; i++) mm.set(i, i)
    })

    let total = 0
    for (let i = 0; i < 2000; i++) total += calls[i]
    assertEqual(total, 1000, 'only updated key signals should notify')

    for (const u of unsubs) u()
  })

  test('stored: subscribe fires immediately and setValue returns boolean', () => {
    const count = signal(0)
    const calls = []

    const unsubscribe = count.subscribe(change => {
      calls.push([change.nextValue, change.previousValue])
    })

    assertEqual(calls.length, 1, 'subscribe should fire immediately')
    assertEqual(calls[0][0], 0, 'initial value')
    assertEqual(calls[0][1], undefined, 'initial previous should be undefined')

    assertEqual(count.setValue(0), false, 'setValue should return false on no-op')
    assertEqual(count.setValue(1), true, 'setValue should return true on change')
    assertEqual(count.setValue(v => v + 1), true, 'setValue should support updater function')

    assertEqual(calls.length, 3, 'should have been notified for 2 changes after initial')
    assertEqual(calls[1][0], 1, 'first update value')
    assertEqual(calls[1][1], 0, 'first update previous')
    assertEqual(calls[2][0], 2, 'second update value')
    assertEqual(calls[2][1], 1, 'second update previous')

    unsubscribe()
  })

  test('stored: safe unsubscribe during notify', () => {
    const count = signal(0)
    let calls = 0
    let unsubscribe

    unsubscribe = count.subscribe(() => {
      calls++
      unsubscribe && unsubscribe()
    })

    count.setValue(1)
    count.setValue(2)

    assertEqual(calls, 2, 'should fire initial + first update, then stop')
  })

  test('derived: cold recomputes on read and holds no upstream subscriptions', () => {
    const source = createSpySignal(1)
    const derived = signal(track => track(source) * 2)

    assertEqual(source.activeSubscriberCount, 0, 'should start with no upstream subscribers')

    assertEqual(derived.getValue(), 2, 'cold read computes')
    assertEqual(source.activeSubscriberCount, 0, 'cold read should not subscribe upstream')

    source.setValue(2)
    assertEqual(derived.getValue(), 4, 'cold read reflects latest upstream changes')
    assertEqual(source.activeSubscriberCount, 0, 'still no upstream subscribers while cold')
  })

  test('derived: hot subscribes upstream and tears down on last unsubscribe', () => {
    const source = createSpySignal(1)
    const derived = signal(track => track(source) + 1)

    assertEqual(source.activeSubscriberCount, 0, 'should start with no upstream subscribers')

    const calls = []
    const unsubscribe = derived.subscribe(change => calls.push([change.nextValue, change.previousValue]))

    assertEqual(calls.length, 1, 'derived subscribe should fire immediately once')
    assertEqual(source.activeSubscriberCount, 1, 'hot derived should subscribe upstream')

    source.setValue(2)
    assertEqual(calls.length, 2, 'should notify on upstream change')
    assertEqual(calls[1][0], 3, 'derived next value')
    assertEqual(calls[1][1], 2, 'derived previous value')

    unsubscribe()
    assertEqual(source.activeSubscriberCount, 0, 'should tear down upstream subscriptions when cold')
  })

  test('derived: does not notify when computed value is unchanged', () => {
    const source = signal(1)
    const derived = signal(track => track(source) % 2)

    const calls = []
    const unsubscribe = derived.subscribe(change => calls.push([change.nextValue, change.previousValue]))

    source.setValue(3)
    assertEqual(calls.length, 1, 'should not notify when computed value is unchanged')

    source.setValue(4)
    assertEqual(calls.length, 2, 'should notify when computed value changes')
    assertEqual(calls[1][0], 0, 'derived next value')
    assertEqual(calls[1][1], 1, 'derived previous value')

    unsubscribe()
  })

  test('overridable: hot follows base, override stops following, clear resumes', () => {
    const base = createSpySignal(1)
    const wrapped = overridable(base)

    const calls = []
    const unsubscribe = wrapped.subscribe(change => calls.push([change.nextValue, change.previousValue]))

    assertEqual(calls.length, 1, 'wrapped subscribe should fire immediately')
    assertEqual(calls[0][0], 1, 'wrapped initial value follows base')
    assertEqual(base.activeSubscriberCount, 1, 'wrapped should subscribe upstream while following + hot')

    base.setValue(2)
    assertEqual(calls.length, 2, 'wrapped should notify when base changes')
    assertEqual(calls[1][0], 2, 'wrapped next value')
    assertEqual(calls[1][1], 1, 'wrapped previous value')

    assertEqual(wrapped.setValue(10), true, 'override setValue should return true when changed')
    assertEqual(wrapped.isOverridden, true, 'wrapped should be overridden after setValue')
    assertEqual(base.activeSubscriberCount, 0, 'wrapped should unsubscribe upstream while overridden')
    assertEqual(wrapped.getValue(), 10, 'wrapped should return override value')

    base.setValue(3)
    assertEqual(calls.length, 3, 'wrapped should notify subscribers when overridden value is set')
    assertEqual(wrapped.getValue(), 10, 'base changes should not affect wrapped while overridden')

    assertEqual(wrapped.clear(), true, 'clear should return true when it changes exposed value')
    assertEqual(wrapped.isOverridden, false, 'wrapped should follow after clear')
    assertEqual(wrapped.getValue(), 3, 'wrapped should snap back to current base value')
    assertEqual(base.activeSubscriberCount, 1, 'wrapped should resubscribe upstream after clear while hot')

    unsubscribe()
    assertEqual(base.activeSubscriberCount, 0, 'wrapped should tear down upstream subscriptions on last unsubscribe')
  })

  test('overridable: cold read does not subscribe upstream', () => {
    const base = createSpySignal(1)
    const wrapped = overridable(base)

    assertEqual(base.activeSubscriberCount, 0, 'should start with no upstream subscribers')
    assertEqual(wrapped.getValue(), 1, 'cold read follows base')
    assertEqual(base.activeSubscriberCount, 0, 'cold read should not subscribe upstream')

    wrapped.setValue(2)
    assertEqual(wrapped.getValue(), 2, 'cold read returns overridden value')
    assertEqual(base.activeSubscriberCount, 0, 'override should not subscribe upstream')

    wrapped.clear()
    base.setValue(3)
    assertEqual(wrapped.getValue(), 3, 'cold read after clear reflects base')
    assertEqual(base.activeSubscriberCount, 0, 'still should not subscribe upstream while cold')
  })

  test('batch: stored signal notifications are deduped', () => {
    const s = signal(0)
    const calls = []

    s.subscribe(change => {
      if (change.kind === 'init') return
      calls.push([change.nextValue, change.previousValue])
    })

    batch(() => {
      s.setValue(1)
      s.setValue(2)
      s.setValue(3)
    })

    assertEqual(calls.length, 1, 'batched updates should notify once')
    assertEqual(calls[0][0], 3, 'next should be final value')
    assertEqual(calls[0][1], 0, 'previous should be first previous')
  })

  test('batch: derived notifications are deduped and flush even on error', () => {
    const a = signal(1)
    const d = signal(track => track(a) * 2)

    const calls = []
    d.subscribe(change => {
      if (change.kind === 'init') return
      calls.push(change.nextValue)
    })

    assertThrows(() => {
      batch(() => {
        a.setValue(2)
        a.setValue(3)
        throw new Error('boom')
      })
    }, /boom/, 'batch should rethrow inner error')

    assertEqual(calls.length, 1, 'derived should flush once even if batch throws')
    assertEqual(calls[0], 6, 'derived should see final value')
  })

  test('derived: dynamic dependencies subscribe/unsubscribe correctly while hot', () => {
    const a = createSpySignal(1)
    const b = createSpySignal(10)
    const useA = signal(true)

    const d = signal(track => track(useA) ? track(a) : track(b))

    const calls = []
    const unsub = d.subscribe(change => {
      if (change.kind === 'init') return
      calls.push(change.nextValue)
    })

    assertEqual(a.activeSubscriberCount, 1, 'should subscribe to a while useA is true')
    assertEqual(b.activeSubscriberCount, 0, 'should not subscribe to b initially')

    useA.setValue(false)

    assertEqual(a.activeSubscriberCount, 0, 'should unsubscribe from a when switching to b')
    assertEqual(b.activeSubscriberCount, 1, 'should subscribe to b when switching')

    b.setValue(11)
    assertEqual(calls[calls.length - 1], 11, 'should reflect b after switching')

    unsub()
    assertEqual(a.activeSubscriberCount, 0, 'should have no upstream when cold')
    assertEqual(b.activeSubscriberCount, 0, 'should have no upstream when cold')
  })

  test('batch: unsubscribe inside batch prevents delivery to that subscriber', () => {
    const s = signal(0)
    const calls = []

    let unsub
    unsub = s.subscribe(change => {
      if (change.kind === 'init') return
      calls.push(change.nextValue)
    })

    batch(() => {
      s.setValue(1)
      unsub()
      s.setValue(2)
    })

    assertEqual(calls.length, 0, 'unsubscribed subscriber should not receive batched flush')
  })

  test('notify: subscriber throw is isolated and other subscribers still run', () => {
    const s = signal(0)
    const okCalls = []

    s.subscribe(change => {
      if (change.kind === 'init') return
      throw new Error('boom')
    })

    s.subscribe(change => {
      if (change.kind === 'init') return
      okCalls.push(change.nextValue)
    })

    assertThrows(() => s.setValue(1), /boom/, 'setValue should rethrow subscriber error')
    assertEqual(okCalls.length, 1, 'other subscribers should still run')
  })

  test('batch: subscriber throw does not prevent other queued notifications', () => {
    const a = signal(0)
    const b = signal(0)

    const calls = []

    a.subscribe(change => {
      if (change.kind === 'init') return
      throw new Error('boom')
    })

    b.subscribe(change => {
      if (change.kind === 'init') return
      calls.push(change.nextValue)
    })

    assertThrows(() => {
      batch(() => {
        a.setValue(1)
        b.setValue(2)
      })
    }, /boom/, 'batch should rethrow error')

    assertEqual(calls.length, 1, 'b should still flush even if a subscriber throws')
    assertEqual(calls[0], 2, 'b should receive its update')
  })

  test('derived: reentrancy guard throws', () => {
    const a = signal(1)
    const d = signal(track => {
      const v = track(a)
      if (v === 1) a.setValue(2)
      return v
    })

    assertThrows(() => d.getValue(), /reentr/i, 'reentrant derived computation should throw')
  })

  test('subscribe: if subscriber throws during init, it is removed', () => {
    const s = signal(0)
    let calls = 0

    assertThrows(() => {
      s.subscribe(() => {
        calls++
        throw new Error('boom')
      })
    }, /boom/, 'subscribe should rethrow init error')

    s.setValue(1)
    assertEqual(calls, 1, 'subscriber should have been removed after throwing during init')
  })

  test('derived: compute throw does not poison future cold reads', () => {
    const a = signal(1)
    let shouldThrow = true

    const d = signal(track => {
      const v = track(a)
      if (shouldThrow) throw new Error('boom')
      return v * 2
    })

    assertThrows(() => d.getValue(), /boom/, 'cold derived compute error should be surfaced')

    shouldThrow = false
    assertEqual(d.getValue(), 2, 'derived should recover on next cold read')

    a.setValue(2)
    assertEqual(d.getValue(), 4, 'derived should continue working after recovering')
  })

  test('derived: subscribe error does not leak upstream subscriptions', () => {
    const a = createSpySignal(1)
    let shouldThrow = true

    const d = signal(track => {
      track(a)
      if (shouldThrow) throw new Error('boom')
      return 1
    })

    assertThrows(() => d.subscribe(() => {}), /boom/, 'subscribe should rethrow derived compute error')
    assertEqual(a.activeSubscriberCount, 0, 'upstream subscriptions should be torn down on subscribe failure')

    shouldThrow = false
    const unsub = d.subscribe(() => {})
    assertEqual(a.activeSubscriberCount, 1, 'derived should subscribe upstream when hot')
    unsub()
    assertEqual(a.activeSubscriberCount, 0, 'derived should tear down upstream when cold')
  })

  test('batch: nested batch coalesces to a single notification', () => {
    const s = signal(0)
    const calls = []

    s.subscribe(change => {
      if (change.kind === 'init') return
      calls.push([change.nextValue, change.previousValue])
    })

    batch(() => {
      s.setValue(1)
      batch(() => {
        s.setValue(2)
      })
      s.setValue(3)
    })

    assertEqual(calls.length, 1, 'nested batched updates should still notify once')
    assertEqual(calls[0][0], 3, 'next should be final value')
    assertEqual(calls[0][1], 0, 'previous should be initial value')
  })

  test('array: mutate throw does not commit or notify', () => {
    const arr = signal.array([1])
    const calls = []

    arr.subscribe(change => {
      if (change.kind === 'init') return
      calls.push(change)
    })

    assertThrows(() => {
      arr.mutate(m => {
        m.push(2)
        throw new Error('boom')
      })
    }, /boom/, 'mutate should rethrow user error')

    assertEqual(arr.getValue().length, 1, 'array value should not change when mutate throws')
    assertEqual(calls.length, 0, 'array should not notify when mutate throws')
  })

  test('object: mutate throw does not commit or notify', () => {
    const obj = signal.object({ a: 1 })
    const calls = []

    obj.subscribe(change => {
      if (change.kind === 'init') return
      calls.push(change)
    })

    assertThrows(() => {
      obj.mutate(m => {
        m.set('b', 2)
        throw new Error('boom')
      })
    }, /boom/, 'mutate should rethrow user error')

    assertEqual(obj.getValue().b, undefined, 'object value should not change when mutate throws')
    assertEqual(calls.length, 0, 'object should not notify when mutate throws')
  })

  test('map: mutate throw does not commit or notify', () => {
    const m = signal.map([['a', 1]])
    const calls = []

    m.subscribe(change => {
      if (change.kind === 'init') return
      calls.push(change)
    })

    assertThrows(() => {
      m.mutate(mm => {
        mm.set('b', 2)
        throw new Error('boom')
      })
    }, /boom/, 'mutate should rethrow user error')

    assertEqual(m.getValue().has('b'), false, 'map value should not change when mutate throws')
    assertEqual(calls.length, 0, 'map should not notify when mutate throws')
  })

  test('set: mutate throw does not commit or notify', () => {
    const s = signal.set(['a'])
    const calls = []

    s.subscribe(change => {
      if (change.kind === 'init') return
      calls.push(change)
    })

    assertThrows(() => {
      s.mutate(ss => {
        ss.add('b')
        throw new Error('boom')
      })
    }, /boom/, 'mutate should rethrow user error')

    assertEqual(s.getValue().has('b'), false, 'set value should not change when mutate throws')
    assertEqual(calls.length, 0, 'set should not notify when mutate throws')
  })

  test('array: mutate updates value and returns patch bundle', () => {
    const arr = signal.array([1, 2, 3, 4])
    const calls = []
    const patchCalls = []

    arr.subscribe(change => {
      if (change.kind === 'init') return
      calls.push([change.nextValue, change.previousValue])
      change.meta && patchCalls.push(change.meta)
    })

    const bundle = arr.mutate($ => $.push(5))

    assert(bundle, 'mutate should return a bundle')
    assertEqual(calls.length, 1, 'should notify once')
    assertEqual(calls[0][0].length, 5, 'next array should have new length')

    assertEqual(patchCalls.length, 1, 'meta patch bundle should be published')
    assertEqual(patchCalls[0].patches.length, 1, 'meta.patches should contain one patch')
  })

  test('array: patch notifications are batched and inverse order composes correctly', () => {
    const arr = signal.array([1])
    const patchCalls = []

    arr.subscribe(change => {
      if (change.kind === 'init') return
      change.meta && patchCalls.push(change.meta)
    })

    batch(() => {
      arr.mutate(m => m.push(2))
      arr.mutate(m => m.push(3))
    })

    assertEqual(patchCalls.length, 1, 'should notify once per batch')
    assertEqual(patchCalls[0].patches.length, 2, 'composed patches should concatenate')
    assertEqual(patchCalls[0].inversePatches.length, 2, 'inverse patches should concatenate')
  })

  test('object: mutate updates value and returns patch bundle', () => {
    const obj = signal.object({ a: 1 })
    const valueCalls = []
    const patchCalls = []

    obj.subscribe(change => {
      if (change.kind === 'init') return
      valueCalls.push([change.nextValue, change.previousValue])
      change.meta && patchCalls.push(change.meta)
    })

    obj.mutate(m => m.set('b', 2))

    assertEqual(valueCalls.length, 1, 'should have initial + update')
    assertEqual(valueCalls[0][0].b, 2, 'next object should include new key')
    assertEqual(valueCalls[0][1].b, undefined, 'previous object should not include new key')

    assertEqual(patchCalls.length, 1, 'patch bundle should be published via meta')
    assertEqual(patchCalls[0].patches.length, 1, 'meta.patches should contain one patch')
  })

  test('object: patch notifications are batched and inverse order composes correctly', () => {
    const obj = signal.object({})
    const patchCalls = []

    obj.subscribe(change => {
      if (change.kind === 'init') return
      change.meta && patchCalls.push(change.meta)
    })

    batch(() => {
      obj.mutate(m => m.set('a', 1))
      obj.mutate(m => m.set('b', 2))
    })

    assertEqual(patchCalls.length, 1, 'should notify once per batch')
    assertEqual(patchCalls[0].patches.length, 2, 'composed patches should concatenate')
    assertEqual(patchCalls[0].inversePatches.length, 2, 'inverse patches should concatenate')
  })

  test('object: delete emits delete patch and inverse set patch', () => {
    const obj = signal.object({ a: 1, b: 2 })

    const valueCalls = []
    const patchCalls = []

    obj.subscribe(change => {
      if (change.kind === 'init') return
      valueCalls.push([change.nextValue, change.previousValue])
      change.meta && patchCalls.push(change.meta)
    })

    const bundle = obj.mutate(m => m.delete('a'))
    assert(bundle, 'mutate(delete) should return a bundle')

    assertEqual(valueCalls.length, 1, 'should notify once')
    assertEqual(valueCalls[0][0].a, undefined, 'next should not have deleted key')
    assertEqual(valueCalls[0][1].a, 1, 'previous should have deleted key')

    assertEqual(patchCalls.length, 1, 'meta patch bundle should be published')
    assertEqual(patchCalls[0].patches.length, 1, 'should have one patch')
    assertEqual(patchCalls[0].patches[0].op, 'delete', 'patch op should be delete')
    assertEqual(patchCalls[0].patches[0].key, 'a', 'delete patch key should match')

    assertEqual(patchCalls[0].inversePatches.length, 1, 'should have one inverse patch')
    assertEqual(patchCalls[0].inversePatches[0].op, 'set', 'inverse patch op should be set')
    assertEqual(patchCalls[0].inversePatches[0].key, 'a', 'inverse set key should match')
    assertEqual(patchCalls[0].inversePatches[0].value, 1, 'inverse set value should match')
  })

  test('object: no-op mutations return null and do not notify', () => {
    const obj = signal.object({ a: 1 })

    const valueCalls = []
    const patchCalls = []

    obj.subscribe(change => {
      if (change.kind === 'init') return
      valueCalls.push(change)
      change.meta && patchCalls.push(change.meta)
    })

    const bundle1 = obj.mutate(m => m.set('a', 1))
    assertEqual(bundle1, null, 'set existing key to same value should be a no-op')

    const bundle2 = obj.mutate(m => m.delete('missing'))
    assertEqual(bundle2, null, 'delete missing key should be a no-op')

    const bundle3 = obj.mutate(m => m.assign({ a: 1 }))
    assertEqual(bundle3, null, 'assign same values should be a no-op')

    assertEqual(valueCalls.length, 0, 'should not notify for no-op mutations')
    assertEqual(patchCalls.length, 0, 'should not publish meta for no-op mutations')
  })

  test('object: assign records multiple set patches and inverse patches in reverse order', () => {
    const obj = signal.object({ a: 1 })

    const patchCalls = []
    obj.subscribe(change => {
      if (change.kind === 'init') return
      change.meta && patchCalls.push(change.meta)
    })

    const bundle = obj.mutate(m => m.assign({ a: 2, b: 3 }))
    assert(bundle, 'mutate(assign) should return a bundle')

    assertEqual(patchCalls.length, 1, 'should publish one meta bundle')
    assertEqual(patchCalls[0].patches.length, 2, 'should record two patches')
    assertEqual(patchCalls[0].patches[0].op, 'set', 'first patch op should be set')
    assertEqual(patchCalls[0].patches[0].key, 'a', 'first patch should be for key a')
    assertEqual(patchCalls[0].patches[1].key, 'b', 'second patch should be for key b')

    assertEqual(patchCalls[0].inversePatches.length, 2, 'should record two inverse patches')
    assertEqual(patchCalls[0].inversePatches[0].op, 'delete', 'first inverse should undo key b creation')
    assertEqual(patchCalls[0].inversePatches[0].key, 'b', 'first inverse should target key b')
    assertEqual(patchCalls[0].inversePatches[1].op, 'set', 'second inverse should restore previous a')
    assertEqual(patchCalls[0].inversePatches[1].key, 'a', 'second inverse should target key a')
    assertEqual(patchCalls[0].inversePatches[1].value, 1, 'inverse set should restore previous value')
  })

  test('map: key(k) is stable and key signals notify only on relevant changes', () => {
    const m = signal.map([[1, 'a']])

    const k1a = m.key(1)
    const k1b = m.key(1)
    assert(k1a === k1b, 'key(1) should return the same signal instance')

    const k2 = m.key(2)

    const k1Calls = []
    const k2Calls = []

    k1a.subscribe(change => {
      if (change.kind === 'init') return
      k1Calls.push(change.nextValue)
    })

    k2.subscribe(change => {
      if (change.kind === 'init') return
      k2Calls.push(change.nextValue)
    })

    m.mutate(mm => {
      mm.set(2, 'b')
    })

    assertEqual(k1Calls.length, 0, 'key(1) signal should not fire when key(2) changes')
    assertEqual(k2Calls.length, 1, 'key(2) signal should fire once')
    assertEqual(k2Calls[0].present, true, 'key(2) should become present')
    assertEqual(k2Calls[0].value, 'b', 'key(2) should have correct value')

    m.mutate(mm => {
      mm.set(1, 'aa')
    })

    assertEqual(k1Calls.length, 1, 'key(1) signal should fire when key(1) changes')
    assertEqual(k1Calls[0].value, 'aa', 'key(1) should update to new value')
  })

  test('map: patch notifications are batched and inverse order composes correctly', () => {
    const m = signal.map()
    const patchCalls = []

    m.subscribe(change => {
      if (change.kind === 'init') return
      change.meta && patchCalls.push(change.meta)
    })

    batch(() => {
      m.mutate(mm => mm.set('a', 1))
      m.mutate(mm => mm.set('b', 2))
    })

    assertEqual(patchCalls.length, 1, 'should notify once per batch')
    assertEqual(patchCalls[0].patches.length, 2, 'patches should concatenate')
    assertEqual(patchCalls[0].inversePatches.length, 2, 'inverse patches should concatenate')
  })

  test('set: value(v) is stable and membership signals notify only on relevant changes', () => {
    const s = signal.set([1])

    const v1a = s.value(1)
    const v1b = s.value(1)
    assert(v1a === v1b, 'value(1) should return the same signal instance')

    const v2 = s.value(2)

    const v1Calls = []
    const v2Calls = []

    v1a.subscribe(change => {
      if (change.kind === 'init') return
      v1Calls.push(change.nextValue)
    })

    v2.subscribe(change => {
      if (change.kind === 'init') return
      v2Calls.push(change.nextValue)
    })

    s.mutate(ss => {
      ss.add(2)
    })

    assertEqual(v1Calls.length, 0, 'value(1) should not fire when value(2) membership changes')
    assertEqual(v2Calls.length, 1, 'value(2) should fire once')
    assertEqual(v2Calls[0].present, true, 'value(2) should become present')

    s.mutate(ss => {
      ss.delete(1)
    })

    assertEqual(v1Calls.length, 1, 'value(1) should fire when value(1) membership changes')
    assertEqual(v1Calls[0].present, false, 'value(1) should become not present')
  })

  test('set: patch notifications are batched and inverse order composes correctly', () => {
    const s = signal.set()
    const patchCalls = []

    s.subscribe(change => {
      if (change.kind === 'init') return
      change.meta && patchCalls.push(change.meta)
    })

    batch(() => {
      s.mutate(ss => ss.add('a'))
      s.mutate(ss => ss.add('b'))
    })

    assertEqual(patchCalls.length, 1, 'should notify once per batch')
    assertEqual(patchCalls[0].patches.length, 2, 'patches should concatenate')
    assertEqual(patchCalls[0].inversePatches.length, 2, 'inverse patches should concatenate')
  })

  test('array.index.length notifies only when length changes', () => {
    const arr = signal.array([1, 2])
    const calls = []

    arr.index.length.subscribe(change => {
      if (change.kind === 'init') return
      calls.push(change.nextValue)
    })

    arr.mutate(m => m.set(0, 10))
    assertEqual(calls.length, 0, 'setting an element should not change length')

    arr.mutate(m => m.push(3))
    assertEqual(calls.length, 1, 'push should change length')
    assertEqual(calls[0], 3, 'length should be updated')
  })

  test('derived array: recomputes from tracked dependencies and is readonly', () => {
    const first = signal('Graham')
    const second = signal('Ada')

    const names = signal.array(track => [track(first), track(second)])

    assertEqual(names.getValue()[0], 'Graham', 'derived array should expose initial first value')
    assertEqual(names.getValue()[1], 'Ada', 'derived array should expose initial second value')
    assertEqual(names.setValue, undefined, 'derived array should not expose setValue')
    assertEqual(names.mutate, undefined, 'derived array should not expose mutate')

    const calls = []
    const unsubscribe = names.subscribe(change => {
      if (change.kind === 'init') return
      calls.push(change.nextValue)
    })

    first.setValue('Grace')

    assertEqual(calls.length, 1, 'derived array should notify when a dependency changes')
    assertEqual(calls[0][0], 'Grace', 'derived array should recompute changed element')
    assertEqual(calls[0][1], 'Ada', 'derived array should preserve other computed elements')

    unsubscribe()
  })

  test('derived array: index length derives from computed value', () => {
    const includeSecond = signal(false)
    const first = signal('Graham')
    const second = signal('Ada')

    const names = signal.array(track => {
      const out = [track(first)]
      if (track(includeSecond)) out.push(track(second))
      return out
    })

    const lengthCalls = []

    names.index.length.subscribe(change => {
      if (change.kind === 'init') return
      lengthCalls.push(change.nextValue)
    })

    first.setValue('Grace')
    assertEqual(lengthCalls.length, 0, 'derived array length index should not notify when length is unchanged')

    includeSecond.setValue(true)
    assertEqual(lengthCalls.length, 1, 'derived array length index should notify when length changes')
    assertEqual(lengthCalls[0], 2, 'derived array length index should update')
  })

  test('derived array: validates computed value', () => {
    const bad = signal.array(() => null)

    assertThrows(() => bad.getValue(), /expects value to be an array/, 'derived array should reject non-array computed values')
  })

  test('derived array: cold reads do not hold upstream subscriptions', () => {
    const source = createSpySignal('Graham')
    const names = signal.array(track => [track(source)])

    assertEqual(source.activeSubscriberCount, 0, 'derived array should start cold')
    assertEqual(names.getValue()[0], 'Graham', 'cold read should compute derived array')
    assertEqual(source.activeSubscriberCount, 0, 'cold read should not subscribe upstream')

    const unsubscribe = names.subscribe(() => {})
    assertEqual(source.activeSubscriberCount, 1, 'subscribed derived array should subscribe upstream')

    unsubscribe()
    assertEqual(source.activeSubscriberCount, 0, 'derived array should tear down upstream when cold')
  })

  test('object.index.keys/size notifies only when key set changes', () => {
    const obj = signal.object({ a: 1, b: 2 })
    const keysCalls = []
    const sizeCalls = []

    obj.index.keys.subscribe(change => {
      if (change.kind === 'init') return
      keysCalls.push(change.nextValue)
    })

    obj.index.size.subscribe(change => {
      if (change.kind === 'init') return
      sizeCalls.push(change.nextValue)
    })

    obj.mutate(m => m.set('a', 10))
    assertEqual(keysCalls.length, 0, 'updating existing key should not change keys index')
    assertEqual(sizeCalls.length, 0, 'updating existing key should not change size index')

    obj.mutate(m => m.set('c', 3))
    assertEqual(keysCalls.length, 1, 'adding new key should update keys index')
    assertEqual(sizeCalls.length, 1, 'adding new key should update size index')
    assertEqual(sizeCalls[0], 3, 'size index should be updated')
  })

  test('derived object: recomputes from tracked dependencies and is readonly', () => {
    const name = signal('Graham')
    const age = signal(41)

    const person = signal.object(track => ({
      name: track(name),
      age: track(age)
    }))

    assertEqual(person.getValue().name, 'Graham', 'derived object should expose initial tracked name')
    assertEqual(person.getValue().age, 41, 'derived object should expose initial tracked age')
    assertEqual(person.setValue, undefined, 'derived object should not expose setValue')
    assertEqual(person.mutate, undefined, 'derived object should not expose mutate')

    const calls = []
    const unsubscribe = person.subscribe(change => {
      if (change.kind === 'init') return
      calls.push(change.nextValue)
    })

    name.setValue('Ada')

    assertEqual(calls.length, 1, 'derived object should notify when a dependency changes')
    assertEqual(calls[0].name, 'Ada', 'derived object should recompute changed name')
    assertEqual(calls[0].age, 41, 'derived object should preserve other computed fields')

    unsubscribe()
  })

  test('derived object: index keys and size derive from computed value', () => {
    const includeAge = signal(false)
    const name = signal('Graham')
    const age = signal(41)

    const person = signal.object(track => {
      const out = { name: track(name) }
      if (track(includeAge)) out.age = track(age)
      return out
    })

    const keysCalls = []
    const sizeCalls = []

    person.index.keys.subscribe(change => {
      if (change.kind === 'init') return
      keysCalls.push(change.nextValue)
    })

    person.index.size.subscribe(change => {
      if (change.kind === 'init') return
      sizeCalls.push(change.nextValue)
    })

    name.setValue('Ada')
    assertEqual(keysCalls.length, 0, 'derived object key index should not notify when keys are unchanged')
    assertEqual(sizeCalls.length, 0, 'derived object size index should not notify when keys are unchanged')

    includeAge.setValue(true)
    assertEqual(keysCalls.length, 1, 'derived object key index should notify when keys change')
    assertEqual(keysCalls[0].length, 2, 'derived object key index should include added key')
    assertEqual(keysCalls[0][1], 'age', 'derived object key index should preserve key order')
    assertEqual(sizeCalls.length, 1, 'derived object size index should notify when size changes')
    assertEqual(sizeCalls[0], 2, 'derived object size index should update')
  })

  test('derived object: validates computed value', () => {
    const bad = signal.object(() => null)

    assertThrows(() => bad.getValue(), /expects value to be an object/, 'derived object should reject non-object computed values')
  })

  test('derived object: cold reads do not hold upstream subscriptions', () => {
    const source = createSpySignal('Graham')
    const person = signal.object(track => ({ name: track(source) }))

    assertEqual(source.activeSubscriberCount, 0, 'derived object should start cold')
    assertEqual(person.getValue().name, 'Graham', 'cold read should compute derived object')
    assertEqual(source.activeSubscriberCount, 0, 'cold read should not subscribe upstream')

    const unsubscribe = person.subscribe(() => {})
    assertEqual(source.activeSubscriberCount, 1, 'subscribed derived object should subscribe upstream')

    unsubscribe()
    assertEqual(source.activeSubscriberCount, 0, 'derived object should tear down upstream when cold')
  })

  test('map.index.keys/size notifies only when keys change', () => {
    const m = signal.map([['a', 1]])
    const keysCalls = []
    const sizeCalls = []

    m.index.keys.subscribe(change => {
      if (change.kind === 'init') return
      keysCalls.push(change.nextValue)
    })

    m.index.size.subscribe(change => {
      if (change.kind === 'init') return
      sizeCalls.push(change.nextValue)
    })

    m.mutate(mm => mm.set('a', 2))
    assertEqual(keysCalls.length, 0, 'updating existing key should not change keys index')
    assertEqual(sizeCalls.length, 0, 'updating existing key should not change size index')

    m.mutate(mm => mm.set('b', 3))
    assertEqual(keysCalls.length, 1, 'adding new key should update keys index')
    assertEqual(sizeCalls.length, 1, 'adding new key should update size index')
    assertEqual(sizeCalls[0], 2, 'size index should be updated')
  })

  test('derived map: recomputes from tracked dependencies and is readonly', () => {
    const name = signal('Graham')
    const age = signal(41)

    const person = signal.map(track => [
      ['name', track(name)],
      ['age', track(age)]
    ])

    assertEqual(person.get('name'), 'Graham', 'derived map should expose initial name value')
    assertEqual(person.get('age'), 41, 'derived map should expose initial age value')
    assertEqual(person.size, 2, 'derived map should expose computed size')
    assertEqual(person.setValue, undefined, 'derived map should not expose setValue')
    assertEqual(person.mutate, undefined, 'derived map should not expose mutate')

    const calls = []
    const unsubscribe = person.subscribe(change => {
      if (change.kind === 'init') return
      calls.push(change.nextValue)
    })

    name.setValue('Ada')

    assertEqual(calls.length, 1, 'derived map should notify when a dependency changes')
    assertEqual(calls[0].get('name'), 'Ada', 'derived map should recompute changed value')
    assertEqual(calls[0].get('age'), 41, 'derived map should preserve other computed entries')

    unsubscribe()
  })

  test('derived map: index keys and size derive from computed value', () => {
    const includeAge = signal(false)
    const name = signal('Graham')
    const age = signal(41)

    const person = signal.map(track => {
      const out = [['name', track(name)]]
      if (track(includeAge)) out.push(['age', track(age)])
      return out
    })

    const keysCalls = []
    const sizeCalls = []

    person.index.keys.subscribe(change => {
      if (change.kind === 'init') return
      keysCalls.push(change.nextValue)
    })

    person.index.size.subscribe(change => {
      if (change.kind === 'init') return
      sizeCalls.push(change.nextValue)
    })

    name.setValue('Ada')
    assertEqual(keysCalls.length, 0, 'derived map key index should not notify when keys are unchanged')
    assertEqual(sizeCalls.length, 0, 'derived map size index should not notify when size is unchanged')

    includeAge.setValue(true)
    assertEqual(keysCalls.length, 1, 'derived map key index should notify when keys change')
    assertEqual(keysCalls[0][1], 'age', 'derived map key index should preserve key order')
    assertEqual(sizeCalls.length, 1, 'derived map size index should notify when size changes')
    assertEqual(sizeCalls[0], 2, 'derived map size index should update')
  })

  test('derived map: key(k) is stable and notifies only on relevant changes', () => {
    const name = signal('Graham')
    const includeAge = signal(false)
    const age = signal(41)

    const person = signal.map(track => {
      const out = [['name', track(name)]]
      if (track(includeAge)) out.push(['age', track(age)])
      return out
    })

    const nameKeyCalls = []
    const ageKeyCalls = []

    const nameKey = person.key('name')
    const ageKeyA = person.key('age')
    const ageKeyB = person.key('age')

    assert(ageKeyA === ageKeyB, 'derived map key(k) should return the same signal instance')

    nameKey.subscribe(change => {
      if (change.kind === 'init') return
      nameKeyCalls.push(change.nextValue)
    })

    ageKeyA.subscribe(change => {
      if (change.kind === 'init') return
      ageKeyCalls.push(change.nextValue)
    })

    name.setValue('Ada')
    assertEqual(nameKeyCalls.length, 1, 'derived map key(name) should notify when name changes')
    assertEqual(nameKeyCalls[0].value, 'Ada', 'derived map key(name) should expose changed value')
    assertEqual(ageKeyCalls.length, 0, 'derived map key(age) should not notify when unrelated key changes')

    includeAge.setValue(true)
    assertEqual(ageKeyCalls.length, 1, 'derived map key(age) should notify when age is added')
    assertEqual(ageKeyCalls[0].present, true, 'derived map key(age) should become present')
    assertEqual(ageKeyCalls[0].value, 41, 'derived map key(age) should expose value')

    age.setValue(42)
    assertEqual(ageKeyCalls.length, 2, 'derived map key(age) should notify when age value changes')
    assertEqual(ageKeyCalls[1].value, 42, 'derived map key(age) should update value')
  })

  test('derived map: validates computed value', () => {
    const bad = signal.map(() => null)

    assertThrows(() => bad.getValue(), /Map signal expects a Map or iterable/, 'derived map should reject non-iterable computed values')
  })

  test('derived map: cold reads do not hold upstream subscriptions', () => {
    const source = createSpySignal('Graham')
    const person = signal.map(track => [['name', track(source)]])

    assertEqual(source.activeSubscriberCount, 0, 'derived map should start cold')
    assertEqual(person.get('name'), 'Graham', 'cold read should compute derived map')
    assertEqual(source.activeSubscriberCount, 0, 'cold read should not subscribe upstream')

    const unsubscribe = person.subscribe(() => {})
    assertEqual(source.activeSubscriberCount, 1, 'subscribed derived map should subscribe upstream')

    unsubscribe()
    assertEqual(source.activeSubscriberCount, 0, 'derived map should tear down upstream when cold')
  })

  test('set.index.values/size notifies on membership changes', () => {
    const s = signal.set(['a'])
    const valuesCalls = []
    const sizeCalls = []

    s.index.values.subscribe(change => {
      if (change.kind === 'init') return
      valuesCalls.push(change.nextValue)
    })

    s.index.size.subscribe(change => {
      if (change.kind === 'init') return
      sizeCalls.push(change.nextValue)
    })

    s.mutate(ss => ss.add('b'))
    assertEqual(valuesCalls.length, 1, 'add should update values index')
    assertEqual(sizeCalls.length, 1, 'add should update size index')
    assertEqual(sizeCalls[0], 2, 'size index should be updated')

    s.mutate(ss => ss.delete('a'))
    assertEqual(valuesCalls.length, 2, 'delete should update values index')
    assertEqual(sizeCalls.length, 2, 'delete should update size index')
    assertEqual(sizeCalls[1], 1, 'size index should be updated')
  })

  test('derived set: recomputes from tracked dependencies and is readonly', () => {
    const first = signal('Graham')
    const second = signal('Ada')

    const names = signal.set(track => [track(first), track(second)])

    assertEqual(names.has('Graham'), true, 'derived set should expose initial first value')
    assertEqual(names.has('Ada'), true, 'derived set should expose initial second value')
    assertEqual(names.size, 2, 'derived set should expose computed size')
    assertEqual(names.setValue, undefined, 'derived set should not expose setValue')
    assertEqual(names.mutate, undefined, 'derived set should not expose mutate')

    const calls = []
    const unsubscribe = names.subscribe(change => {
      if (change.kind === 'init') return
      calls.push(change.nextValue)
    })

    first.setValue('Grace')

    assertEqual(calls.length, 1, 'derived set should notify when a dependency changes')
    assertEqual(calls[0].has('Grace'), true, 'derived set should recompute changed value')
    assertEqual(calls[0].has('Graham'), false, 'derived set should remove old computed value')

    unsubscribe()
  })

  test('derived set: index values and size derive from computed value', () => {
    const includeSecond = signal(false)
    const first = signal('Graham')
    const second = signal('Ada')

    const names = signal.set(track => {
      const out = [track(first)]
      if (track(includeSecond)) out.push(track(second))
      return out
    })

    const valuesCalls = []
    const sizeCalls = []

    names.index.values.subscribe(change => {
      if (change.kind === 'init') return
      valuesCalls.push(change.nextValue)
    })

    names.index.size.subscribe(change => {
      if (change.kind === 'init') return
      sizeCalls.push(change.nextValue)
    })

    first.setValue('Grace')
    assertEqual(valuesCalls.length, 1, 'derived set values index should notify when values change')
    assertEqual(valuesCalls[0][0], 'Grace', 'derived set values index should preserve order')
    assertEqual(sizeCalls.length, 0, 'derived set size index should not notify when size is unchanged')

    includeSecond.setValue(true)
    assertEqual(valuesCalls.length, 2, 'derived set values index should notify when values are added')
    assertEqual(valuesCalls[1][1], 'Ada', 'derived set values index should include added value')
    assertEqual(sizeCalls.length, 1, 'derived set size index should notify when size changes')
    assertEqual(sizeCalls[0], 2, 'derived set size index should update')
  })

  test('derived set: value(v) is stable and notifies only on membership changes', () => {
    const includeSecond = signal(false)
    const names = signal.set(track => track(includeSecond) ? ['Graham', 'Ada'] : ['Graham'])

    const v1a = names.value('Ada')
    const v1b = names.value('Ada')
    assert(v1a === v1b, 'derived set value(v) should return the same signal instance')

    const calls = []
    v1a.subscribe(change => {
      if (change.kind === 'init') return
      calls.push(change.nextValue)
    })

    includeSecond.setValue(true)
    assertEqual(calls.length, 1, 'derived set value(v) should notify when membership changes')
    assertEqual(calls[0].present, true, 'derived set value(v) should become present')

    includeSecond.setValue(false)
    assertEqual(calls.length, 2, 'derived set value(v) should notify when membership changes again')
    assertEqual(calls[1].present, false, 'derived set value(v) should become absent')
  })

  test('derived set: validates computed value', () => {
    const bad = signal.set(() => null)

    assertThrows(() => bad.getValue(), /Set signal expects a Set or iterable/, 'derived set should reject non-iterable computed values')
  })

  test('derived set: cold reads do not hold upstream subscriptions', () => {
    const source = createSpySignal('Graham')
    const names = signal.set(track => [track(source)])

    assertEqual(source.activeSubscriberCount, 0, 'derived set should start cold')
    assertEqual(names.has('Graham'), true, 'cold read should compute derived set')
    assertEqual(source.activeSubscriberCount, 0, 'cold read should not subscribe upstream')

    const unsubscribe = names.subscribe(() => {})
    assertEqual(source.activeSubscriberCount, 1, 'subscribed derived set should subscribe upstream')

    unsubscribe()
    assertEqual(source.activeSubscriberCount, 0, 'derived set should tear down upstream when cold')
  })

  test('map: setValue notifies when iteration order changes', () => {
    const m = signal.map([['a', 1], ['b', 2]])

    const valueCalls = []
    m.subscribe(change => {
      if (change.kind === 'init') return
      valueCalls.push([...change.nextValue.keys()])
    })

    const indexKeysCalls = []
    m.index.keys.subscribe(change => {
      if (change.kind === 'init') return
      indexKeysCalls.push(change.nextValue)
    })

    m.setValue([['b', 2], ['a', 1]])

    assertEqual(valueCalls.length, 1, 'should notify on order-only change')
    assertEqual(valueCalls[0][0], 'b', 'iteration order should update')
    assertEqual(indexKeysCalls.length, 1, 'index.keys should notify on order-only change')
    assertEqual(indexKeysCalls[0][0], 'b', 'index.keys should reflect new order')
  })

  test('set: setValue notifies when iteration order changes', () => {
    const s = signal.set(['a', 'b'])

    const valueCalls = []
    s.subscribe(change => {
      if (change.kind === 'init') return
      valueCalls.push([...change.nextValue.values()])
    })

    const indexValuesCalls = []
    s.index.values.subscribe(change => {
      if (change.kind === 'init') return
      indexValuesCalls.push(change.nextValue)
    })

    s.setValue(['b', 'a'])

    assertEqual(valueCalls.length, 1, 'should notify on order-only change')
    assertEqual(valueCalls[0][0], 'b', 'iteration order should update')
    assertEqual(indexValuesCalls.length, 1, 'index.values should notify on order-only change')
    assertEqual(indexValuesCalls[0][0], 'b', 'index.values should reflect new order')
  })

  test('patch bundles are deeply immutable (meta + return values)', () => {
    function assertImmutableBundle (bundle) {
      assert(bundle && typeof bundle === 'object', 'bundle should exist')
      assert(Object.isFrozen(bundle), 'bundle object should be frozen')
      assert(Object.isFrozen(bundle.patches), 'bundle.patches should be frozen')
      assert(Object.isFrozen(bundle.inversePatches), 'bundle.inversePatches should be frozen')
      assert(bundle.patches.length > 0, 'bundle should have patches')
      assert(bundle.inversePatches.length > 0, 'bundle should have inverse patches')
      assert(Object.isFrozen(bundle.patches[0]), 'patch objects should be frozen')
      assert(Object.isFrozen(bundle.inversePatches[0]), 'inverse patch objects should be frozen')
    }

    function assertImmutableMeta (meta) {
      assert(meta && typeof meta === 'object', 'meta should exist')
      assert(Object.isFrozen(meta), 'meta object should be frozen')
      assert(Object.isFrozen(meta.patches), 'meta.patches should be frozen')
      assert(Object.isFrozen(meta.inversePatches), 'meta.inversePatches should be frozen')
      assert(meta.patches.length > 0, 'meta should have patches')
      assert(meta.inversePatches.length > 0, 'meta should have inverse patches')
      assert(Object.isFrozen(meta.patches[0]), 'meta patch objects should be frozen')
      assert(Object.isFrozen(meta.inversePatches[0]), 'meta inverse patch objects should be frozen')
    }

    function collectMeta (sig, fn) {
      let meta
      sig.subscribe(change => {
        if (change.kind === 'init') return
        meta = change.meta
      })
      const bundle = sig.mutate(fn)
      return { meta, bundle }
    }

    {
      const arr = signal.array([1])
      const { meta, bundle } = collectMeta(arr, m => m.push(2))
      assertImmutableMeta(meta)
      assertImmutableBundle(bundle)
    }

    {
      const obj = signal.object({})
      const { meta, bundle } = collectMeta(obj, m => m.set('a', 1))
      assertImmutableMeta(meta)
      assertImmutableBundle(bundle)
    }

    {
      const m = signal.map()
      const { meta, bundle } = collectMeta(m, mm => mm.set('a', 1))
      assertImmutableMeta(meta)
      assertImmutableBundle(bundle)
    }

    {
      const s = signal.set()
      const { meta, bundle } = collectMeta(s, ss => ss.add('a'))
      assertImmutableMeta(meta)
      assertImmutableBundle(bundle)
    }

    ;(function () {
      'use strict'

      const arr = signal.array([1])
      const { meta, bundle } = collectMeta(arr, m => m.push(2))

      assertThrows(() => { meta.patches.push({ op: 'x' }) }, 'meta.patches should be immutable')
      assertThrows(() => { meta.patches[0].op = 'x' }, 'meta patch objects should be immutable')

      assertThrows(() => { bundle.patches.push({ op: 'x' }) }, 'bundle.patches should be immutable')
      assertThrows(() => { bundle.patches[0].op = 'x' }, 'bundle patch objects should be immutable')
    })()
  })

  test('subscriptions: a subscriber can unsubscribe itself during notify', () => {
    const s = signal(0)

    const aCalls = []
    const bCalls = []

    let unsubA

    unsubA = s.subscribe(change => {
      if (change.kind === 'init') return
      aCalls.push(change.nextValue)
      unsubA()
    })

    s.subscribe(change => {
      if (change.kind === 'init') return
      bCalls.push(change.nextValue)
    })

    s.setValue(1)
    s.setValue(2)

    assertEqual(aCalls.length, 1, 'A should only receive first update')
    assertEqual(aCalls[0], 1, 'A should receive first update value')

    assertEqual(bCalls.length, 2, 'B should receive both updates')
    assertEqual(bCalls[0], 1, 'B should receive first update')
    assertEqual(bCalls[1], 2, 'B should receive second update')
  })

  test('subscriptions: a subscriber can unsubscribe another subscriber during notify', () => {
    const s = signal(0)

    const aCalls = []
    const bCalls = []

    let unsubB

    s.subscribe(change => {
      if (change.kind === 'init') return
      aCalls.push(change.nextValue)
      unsubB()
    })

    unsubB = s.subscribe(change => {
      if (change.kind === 'init') return
      bCalls.push(change.nextValue)
    })

    s.setValue(1)

    assertEqual(aCalls.length, 1, 'A should receive update')
    assertEqual(bCalls.length, 0, 'B should not be called once unsubscribed during notify')
  })

  test('subscriptions: subscribing during notify runs init immediately but does not receive current update', () => {
    const s = signal(0)

    const aCalls = []
    const cCalls = []

    let didSubscribeC = false

    s.subscribe(change => {
      if (change.kind === 'init') return
      aCalls.push(change.nextValue)

      if (!didSubscribeC) {
        didSubscribeC = true
        s.subscribe(cChange => {
          cCalls.push(cChange.kind)
        })
      }
    })

    s.setValue(1)

    assertEqual(aCalls.length, 1, 'A should receive the update')
    assertEqual(cCalls.length, 1, 'C should have been subscribed and run init immediately')
    assertEqual(cCalls[0], 'init', 'C should receive init, not the in-flight update')

    s.setValue(2)
    assertEqual(cCalls.length, 2, 'C should receive next update after being subscribed')
    assertEqual(cCalls[1], 'update', 'C second call should be update')
  })

  test('subscriptions: subscriber throw is isolated and rethrown after others run', () => {
    const s = signal(0)

    const okCalls = []

    s.subscribe(change => {
      if (change.kind === 'init') return
      throw new Error('boom')
    })

    s.subscribe(change => {
      if (change.kind === 'init') return
      okCalls.push(change.nextValue)
    })

    assertThrows(() => s.setValue(1), /boom/, 'setValue should rethrow subscriber error')
    assertEqual(okCalls.length, 1, 'other subscribers should still run even if one throws')
    assertEqual(okCalls[0], 1, 'other subscriber should receive update value')
  })

  test('history: transaction groups bundles into one undo step', () => {
    const state = { count: 0 }

    const applyPatches = patches => {
      for (const p of patches) {
        if (p.op !== 'set') throw new Error('unexpected patch op')
        state[p.key] = p.value
      }
    }

    const history = createHistory({ applyPatches, limit: 50 })

    history.transaction(() => {
      history.record({
        patches: [{ op: 'set', key: 'count', value: 1 }],
        inversePatches: [{ op: 'set', key: 'count', value: 0 }]
      })

      history.record({
        patches: [{ op: 'set', key: 'count', value: 2 }],
        inversePatches: [{ op: 'set', key: 'count', value: 1 }]
      })
    })

    assertEqual(state.count, 0, 'record() should not apply patches by itself')
    assertEqual(history.canUndo, true, 'history should have undo after transaction')
  })

  test('history: undo/redo applies inverse/forward patches', () => {
    const state = { count: 0 }

    const applyPatches = patches => {
      for (const p of patches) state[p.key] = p.value
    }

    const history = createHistory({ applyPatches, limit: 50 })

    history.perform({
      patches: [{ op: 'set', key: 'count', value: 1 }],
      inversePatches: [{ op: 'set', key: 'count', value: 0 }]
    })

    history.perform({
      patches: [{ op: 'set', key: 'count', value: 2 }],
      inversePatches: [{ op: 'set', key: 'count', value: 1 }]
    })

    assertEqual(state.count, 2, 'state should be at latest value')

    assertEqual(history.undo(), true, 'undo should succeed')
    assertEqual(state.count, 1, 'undo should restore previous value')

    assertEqual(history.redo(), true, 'redo should succeed')
    assertEqual(state.count, 2, 'redo should reapply next value')
  })

  test('history: subscribe can drive canUndo/canRedo signals', () => {
    const state = { count: 0 }

    const applyPatches = patches => {
      for (const p of patches) state[p.key] = p.value
    }

    const history = createHistory({ applyPatches, limit: 50 })
    const canUndo = signal(history.canUndo)
    const canRedo = signal(history.canRedo)

    history.subscribe(next => {
      canUndo.setValue(next.canUndo)
      canRedo.setValue(next.canRedo)
    })

    assertEqual(canUndo.getValue(), false, 'initial canUndo should be false')
    assertEqual(canRedo.getValue(), false, 'initial canRedo should be false')

    history.perform({
      patches: [{ op: 'set', key: 'count', value: 1 }],
      inversePatches: [{ op: 'set', key: 'count', value: 0 }]
    })

    assertEqual(canUndo.getValue(), true, 'canUndo should become true after perform')
    assertEqual(canRedo.getValue(), false, 'canRedo should remain false after perform')

    history.undo()
    assertEqual(canUndo.getValue(), false, 'canUndo should become false after undo to empty')
    assertEqual(canRedo.getValue(), true, 'canRedo should become true after undo')
  })

  if (results.fail) {
    throw new Error(`Smoke tests failed: ${results.fail} failing, ${results.pass} passing`)
  }

  console.log(`Smoke tests passed: ${results.pass} passing`)
  return results
}
