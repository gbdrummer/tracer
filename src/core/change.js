function freezeChange (change) {
  return Object.freeze(change)
}

function freezePatchBundle (bundle) {
  if (!bundle || typeof bundle !== 'object') return Object.freeze(bundle)

  const patches = Array.isArray(bundle.patches) ? bundle.patches.slice() : undefined
  const inversePatches = Array.isArray(bundle.inversePatches) ? bundle.inversePatches.slice() : undefined

  if (patches) {
    for (let i = 0; i < patches.length; i++) {
      const p = patches[i]
      if (p && typeof p === 'object' && !Object.isFrozen(p)) patches[i] = Object.freeze(p)
    }
  }

  if (inversePatches) {
    for (let i = 0; i < inversePatches.length; i++) {
      const p = inversePatches[i]
      if (p && typeof p === 'object' && !Object.isFrozen(p)) inversePatches[i] = Object.freeze(p)
    }
  }

  return Object.freeze({
    ...bundle,
    patches: patches ? Object.freeze(patches) : undefined,
    inversePatches: inversePatches ? Object.freeze(inversePatches) : undefined
  })
}

function protectMeta (meta) {
  if (meta === undefined) return undefined

  if (!meta || typeof meta !== 'object') return meta

  if (Object.isFrozen(meta)) return meta

  if ('patches' in meta || 'inversePatches' in meta) {
    return freezePatchBundle(meta)
  }

  return Object.isFrozen(meta) ? meta : Object.freeze(meta)
}

export function createInitChange ({ nextValue, meta } = {}) {
  return freezeChange({ kind: 'init', nextValue, previousValue: undefined, meta: protectMeta(meta) })
}

export function createUpdateChange ({ nextValue, previousValue, meta } = {}) {
  return freezeChange({ kind: 'update', nextValue, previousValue, meta: protectMeta(meta) })
}

export function normalizeChange (change) {
  if (!change || typeof change !== 'object') throw new TypeError('normalizeChange(change) expects a change object')
  if (!('nextValue' in change) || !('previousValue' in change)) throw new TypeError('change requires nextValue and previousValue')

  const kind = change.kind ?? 'update'
  if (kind !== 'init' && kind !== 'update') throw new TypeError('change.kind must be init or update')

  if (
    Object.isFrozen(change) &&
    change.kind === kind &&
    (change.meta === undefined || !change.meta || typeof change.meta !== 'object' || Object.isFrozen(change.meta))
  ) {
    return change
  }

  const meta = protectMeta(change.meta)

  if (Object.isFrozen(change) && change.kind === kind && meta === change.meta) return change

  return freezeChange({
    kind,
    nextValue: change.nextValue,
    previousValue: change.previousValue,
    meta
  })
}

export function composeMeta (previousMeta, nextMeta) {
  if (previousMeta === undefined) return nextMeta
  if (nextMeta === undefined) return previousMeta

  const prevIsBundle = previousMeta && typeof previousMeta === 'object' && Array.isArray(previousMeta.patches) && Array.isArray(previousMeta.inversePatches)
  const nextIsBundle = nextMeta && typeof nextMeta === 'object' && Array.isArray(nextMeta.patches) && Array.isArray(nextMeta.inversePatches)

  if (prevIsBundle && nextIsBundle) {
    return freezePatchBundle({
      patches: previousMeta.patches.concat(nextMeta.patches),
      inversePatches: nextMeta.inversePatches.concat(previousMeta.inversePatches)
    })
  }

  return nextMeta
}

export function composeChanges (previous, next) {
  if (!previous) return next
  if (!next) return previous

  const prev = normalizeChange(previous)
  const n = normalizeChange(next)

  return createUpdateChange({
    nextValue: n.nextValue,
    previousValue: prev.previousValue,
    meta: composeMeta(prev.meta, n.meta)
  })
}

export function createBatchedChangeAccumulator () {
  let previousValue
  let nextValue

  let metaType = 0
  let meta
  let patchSegments
  let inverseSegments
  let bundleBase

  function resetMeta () {
    metaType = 0
    meta = undefined
    patchSegments = inverseSegments = bundleBase = undefined
  }

  function isPatchBundle (m) {
    return !!m && typeof m === 'object' && Array.isArray(m.patches) && Array.isArray(m.inversePatches)
  }

  function setMeta (m) {
    metaType = 1
    meta = m
    patchSegments = inverseSegments = bundleBase = undefined
  }

  function setBundle (m) {
    metaType = 2
    patchSegments = [m.patches]
    inverseSegments = [m.inversePatches]
    bundleBase = m
    meta = undefined
  }

  function appendBundle (m) {
    patchSegments.push(m.patches)
    inverseSegments.push(m.inversePatches)
    bundleBase = m
  }

  function accumulateMeta (m) {
    if (m === undefined) return

    if (!metaType) {
      if (isPatchBundle(m)) setBundle(m)
      else setMeta(m)
      return
    }

    if (metaType === 2 && isPatchBundle(m)) {
      appendBundle(m)
      return
    }

    if (isPatchBundle(m)) {
      setBundle(m)
      return
    }

    setMeta(m)
  }

  function finalizeMeta () {
    if (!metaType) return undefined
    if (metaType === 1) return meta

    if (patchSegments.length === 1) return bundleBase

    const patches = []
    for (const seg of patchSegments) patches.push(...seg)

    const inversePatches = []
    for (let i = inverseSegments.length - 1; i >= 0; i--) {
      inversePatches.push(...inverseSegments[i])
    }

    return Object.freeze({
      ...bundleBase,
      patches: Object.freeze(patches),
      inversePatches: Object.freeze(inversePatches)
    })
  }

  return Object.freeze({
    reset: change => {
      const c = normalizeChange(change)
      previousValue = c.previousValue
      nextValue = c.nextValue
      resetMeta()
      accumulateMeta(c.meta)
    },

    push: change => {
      const c = normalizeChange(change)
      nextValue = c.nextValue
      accumulateMeta(c.meta)
    },

    flush: () => {
      const out = createUpdateChange({ nextValue, previousValue, meta: finalizeMeta() })
      previousValue = nextValue = undefined
      resetMeta()
      return out
    }
  })
}
