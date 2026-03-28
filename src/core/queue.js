let depth = 0

const queue = new Map // key -> flush()
const keys = []

export function batch (fn) {
  depth++
  let result
  let firstError

  try {
    result = fn()
  } finally {
    depth--

    if (depth === 0) {
      try {
        flush()
      } catch (err) {
        firstError ??= err
      }
    }
  }

  if (firstError) throw firstError
  return result
}

export function isBatching () {
  return depth > 0
}

export function enqueue (key, flushFn) {
  if (queue.has(key)) return
  queue.set(key, flushFn)
  keys.push(key)
}

function flush () {
  let firstError

  while (keys.length) {
    const pendingKeys = keys.slice()
    keys.length = 0

    for (const key of pendingKeys) {
      const flushFn = queue.get(key)
      queue.delete(key)

      try {
        flushFn?.()
      } catch (err) {
        firstError ??= err
      }
    }
  }

  if (firstError) throw firstError
}
