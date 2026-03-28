import { SIGNAL_BRAND } from './constants.js'

export default Object.defineProperty(TracerSignal, Symbol.hasInstance, {
  value: v => !!v && v[SIGNAL_BRAND] === true
})

function TracerSignal () {
  throw new TypeError('TracerSignal is not constructible')
}