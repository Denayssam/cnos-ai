import * as fs from 'fs';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'propose_plan',
    description: 'Create an IMPLEMENTATION_PLAN.md for complex tasks. Use this before making major changes to align on approach.',
    parameters: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'Full markdown content of the implementation plan.' },
      },
      required: ['plan'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const plan = args.plan as string;
  if (!plan) { return { success: false, output: 'Plan content is required.' }; }
  const fp = safePath(workspacePath, 'IMPLEMENTATION_PLAN.md');
  fs.writeFileSync(fp, plan, 'utf-8');
  return { success: true, output: 'IMPLEMENTATION_PLAN.md created. Please review it and confirm if I should proceed.' };
}
