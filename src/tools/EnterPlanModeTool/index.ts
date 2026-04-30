import { ToolResult, NativeTool } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'enter_plan_mode',
    description:
      'Spawns the @planner sub-agent to analyze the codebase and produce a structured IMPLEMENTATION_PLAN.md ' +
      'at .fluxo/IMPLEMENTATION_PLAN.md before any code is written. ' +
      'Required before any create_team delegation for tasks touching more than 1 file or involving logical refactoring. ' +
      'The planner is read-only — it only writes the plan file. ' +
      'FALLBACK RULE: If this tool fails to produce the implementation plan due to circuit breaker limits, DO NOT retry it. ' +
      'The fallback is to use ask_user_approval to request human help. ' +
      'You have STRICTLY PROHIBITED assigning tasks to the @coder without an IMPLEMENTATION_PLAN.md.',
    parameters: {
      type: 'object',
      properties: {
        task_description: {
          type: 'string',
          description:
            'Complete description of the task the planner must analyze and break down into sequential, ' +
            'file-precise implementation steps. Include all known context: tech stack, files suspected, goal.',
        },
      },
      required: ['task_description'],
    },
  },
};

export function execute(_args: Record<string, any>, _workspacePath: string): ToolResult {
  return {
    success: false,
    output: '[SYSTEM]: enter_plan_mode is intercepted by the engine. This execute() body should never run.',
  };
}
