/** The first of two plugins that register the same tool name. */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'collide-a'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'shared_tool',
    description: 'the first claimant of `shared_tool`',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'a' },
  }))
}
export default { name, inject, apply }
