/** A fixture plugin that waits for a service nothing provides. */
export const name = 'waiting-fixture'
export const inject = ['neverProvidedService']
export function apply() {}
export default { name, inject, apply }
