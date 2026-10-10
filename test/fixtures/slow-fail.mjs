/** A fixture whose import is slow and whose activation then throws. */
await new Promise(resolve => { setTimeout(resolve, 120) })

export const name = 'slow-fail-fixture'
export function apply() {
  throw new Error('slow boom: activation failed after a slow import')
}
export default { name, apply }
