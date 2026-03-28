export default function createHistory ({ applyPatches, limit = Infinity } = {}) {
  if (typeof applyPatches !== 'function') throw new TypeError('createHistory({ applyPatches }) expects applyPatches to be a function')
  if (!Number.isFinite(limit)) limit = Infinity
  if (limit < 0) throw new TypeError('createHistory({ limit }) expects limit to be a non-negative number')

  const past = []
  const future = []
  const subscriptions = new Set

  let depth = 0
  let pendingBundles = null
  let isApplying = false

  function cloneAndFreezePatchArray (patches) {
    if (!Array.isArray(patches)) throw new TypeError('Expected patch list to be an array')

    const next = patches.map(patch => {
      if (!patch || typeof patch !== 'object') return patch
      return Object.freeze({ ...patch })
    })

    return Object.freeze(next)
  }

  function getState () {
    return {
      canUndo: past.length > 0,
      canRedo: future.length > 0
    }
  }

  function notify (previousState) {
    if (subscriptions.size === 0) return

    const nextState = getState()
    let firstError

    for (const cb of subscriptions) {
      try {
        cb(nextState, previousState)
      } catch (err) {
        firstError ??= err
      }
    }

    if (firstError) throw firstError
  }

  function notifyIfChanged (previousState) {
    const next = getState()
    if (previousState.canUndo === next.canUndo && previousState.canRedo === next.canRedo) return
    notify(previousState)
  }

  function subscribe (cb) {
    if (typeof cb !== 'function') throw new TypeError('history.subscribe(cb) expects cb to be a function')

    subscriptions.add(cb)
    try {
      cb(getState(), undefined)
    } catch (err) {
      subscriptions.delete(cb)
      throw err
    }

    return () => {
      subscriptions.delete(cb)
    }
  }

  function commitPending () {
    if (!pendingBundles || pendingBundles.length === 0) return
    if (limit === 0) {
      pendingBundles = null
      return
    }

    past.push({ bundles: pendingBundles })
    pendingBundles = null

    if (past.length > limit) past.splice(0, past.length - limit)
  }

  function record (bundle) {
    if (isApplying) return false

    const previousState = getState()

    const patches = bundle?.patches
    const inversePatches = bundle?.inversePatches

    if (!Array.isArray(patches) || !Array.isArray(inversePatches)) {
      throw new TypeError('history.record({ patches, inversePatches }) expects patches and inversePatches to be arrays')
    }

    const nextBundle = {
      patches: cloneAndFreezePatchArray(patches),
      inversePatches: cloneAndFreezePatchArray(inversePatches),
      meta: bundle?.meta
    }

    if (depth > 0) {
      pendingBundles ??= []
      pendingBundles.push(nextBundle)
      return true
    }

    if (limit === 0) return false

    past.push({ bundles: [nextBundle] })
    if (past.length > limit) past.splice(0, past.length - limit)
    future.length = 0

    notifyIfChanged(previousState)
    return true
  }

  function perform (bundle) {
    if (isApplying) throw new Error('history.perform() cannot be called while applying history')

    const patches = bundle?.patches
    if (!Array.isArray(patches)) throw new TypeError('history.perform({ patches }) expects patches to be an array')

    applyPatches(patches)

    const recorded = record(bundle)
    if (!recorded) return false
    return true
  }

  function transaction (fn) {
    const previousState = depth === 0 ? getState() : null
    depth++
    try {
      return fn()
    } finally {
      depth--
      if (depth === 0) {
        commitPending()
        future.length = 0
        previousState && notifyIfChanged(previousState)
      }
    }
  }

  function undo (count = 1) {
    if (!Number.isInteger(count) || count < 0) throw new TypeError('history.undo(count) expects count to be a non-negative integer')
    if (count === 0 || past.length === 0) return false

    const previousState = getState()
    let didUndo = false

    isApplying = true
    try {
      while (count-- > 0 && past.length > 0) {
        const step = past[past.length - 1]

        for (let i = step.bundles.length - 1; i >= 0; i--) {
          const bundle = step.bundles[i]
          applyPatches(bundle.inversePatches)
        }

        past.pop()
        future.push(step)
        didUndo = true
      }
    } finally {
      isApplying = false
    }

    didUndo && notifyIfChanged(previousState)
    return didUndo
  }

  function redo (count = 1) {
    if (!Number.isInteger(count) || count < 0) throw new TypeError('history.redo(count) expects count to be a non-negative integer')
    if (count === 0 || future.length === 0) return false

    const previousState = getState()
    let didRedo = false

    isApplying = true
    try {
      while (count-- > 0 && future.length > 0) {
        const step = future[future.length - 1]

        for (const bundle of step.bundles) applyPatches(bundle.patches)

        future.pop()
        past.push(step)
        didRedo = true
      }
    } finally {
      isApplying = false
    }

    if (past.length > limit) past.splice(0, past.length - limit)

    didRedo && notifyIfChanged(previousState)
    return didRedo
  }

  function clear () {
    const previousState = getState()
    past.length = 0
    future.length = 0
    pendingBundles = null
    depth = 0

    notifyIfChanged(previousState)
  }

  function getStacks () {
    return {
      past: past.map(step => ({ ...step, bundles: step.bundles.slice() })),
      future: future.map(step => ({ ...step, bundles: step.bundles.slice() }))
    }
  }

  return Object.defineProperties({}, {
    transaction: { value: transaction },
    record: { value: record },
    perform: { value: perform },
    undo: { value: undo },
    redo: { value: redo },
    clear: { value: clear },
    getStacks: { value: getStacks },
    subscribe: { value: subscribe },

    canUndo: { get: () => past.length > 0 },
    canRedo: { get: () => future.length > 0 }
  })
}
