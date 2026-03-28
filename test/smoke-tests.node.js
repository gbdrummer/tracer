import { runSmokeTests } from './smoke-tests.js'

try {
  runSmokeTests()
} catch (err) {
  console.error(err)
  process.exitCode = 1
}
