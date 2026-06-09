import createDerivedSignal from '../core/createDerivedSignal.js'

export function createStableSnapshotSignal (source, createSnapshot) {
  let previousSnapshot

  return createDerivedSignal(track => {
    const snapshot = createSnapshot(track(source))

    if (previousSnapshot && previousSnapshot.length === snapshot.length) {
      let same = true
      for (let i = 0; i < snapshot.length; i++) {
        if (!Object.is(snapshot[i], previousSnapshot[i])) {
          same = false
          break
        }
      }
      if (same) return previousSnapshot
    }

    previousSnapshot = Object.freeze(snapshot)
    return previousSnapshot
  })
}
