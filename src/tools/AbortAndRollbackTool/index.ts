import { NativeTool, ToolResult } from '../shared';
import { rollbackToLastCheckpoint } from '../../utils/gitSafety';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'abort_and_rollback',
    description:
      'Use this tool ONLY if you realize your edits have fundamentally broken the project\'s logic, ' +
      'or if the user commands you to revert your changes. ' +
      'It will instantly reset the codebase to the state before you started the task ' +
      'by running git reset --hard HEAD~1 against the fluxo-auto-checkpoint anchor commit. ' +
      'WARNING: This is irreversible within the current session — all agent file edits will be discarded.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Brief explanation of why the rollback is being triggered.',
        },
      },
      required: ['reason'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  return rollbackToLastCheckpoint(workspacePath);
}
