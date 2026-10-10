/** The second plugin to claim `shared_tool`: its registration throws, and its fiber unloads. */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'collide-b'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'shared_tool',
    description: 'the second claimant of `shared_tool` — this registration throws',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'b' },
  }))
  // Never reached when the registration above throws.
  ctx.tools.register(defineTool({
    name: 'second_tool_of_collide_b',
    description: 'a tool that never appears, because the fiber unloads whole',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'b2' },
  }))
}
export default { name, inject, apply }
