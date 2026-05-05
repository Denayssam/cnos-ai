import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';

const MEMORY_RELATIVE = '.fluxo/memory.md';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'update_memory',
    description:
      'Append a structured Decision Log entry to .fluxo/memory.md. ' +
      'Use this tool after completing a complex task or recovering from a severe error ' +
      '(e.g. Circuit Breaker activation, repeated build failures, tool misuse). ' +
      'The lesson is appended non-destructively — existing entries are never overwritten. ' +
      'Future sessions will read these entries to avoid repeating past mistakes. ' +
      'IMPORTANT: Only call this tool AFTER npm run build confirms the build is green — ' +
      'the lesson must reflect the final, verified state of the repository.',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description:
            'Short identifier or description of the task context. ' +
            'Examples: "auth-refactor", "stripe-webhook-fix", "circuit-breaker-recovery".',
        },
        outcome: {
          type: 'string',
          enum: ['Success', 'Failure'],
          description: 'Whether the task ultimately succeeded or failed.',
        },
        lesson: {
          type: 'string',
          description:
            '2-sentence lesson learned. First sentence: what went wrong or what was the key insight. ' +
            'Second sentence: what the correct approach is for next time.',
        },
      },
      required: ['task_id', 'outcome', 'lesson'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const { task_id, outcome, lesson } = args;

  if (typeof task_id !== 'string' || task_id.trim() === '') {
    return { success: false, output: 'CRITICAL ERROR: "task_id" is required and must be a non-empty string.' };
  }
  if (outcome !== 'Success' && outcome !== 'Failure') {
    return { success: false, output: 'CRITICAL ERROR: "outcome" must be either "Success" or "Failure".' };
  }
  if (typeof lesson !== 'string' || lesson.trim() === '') {
    return { success: false, output: 'CRITICAL ERROR: "lesson" is required and must be a non-empty string.' };
  }

  let memoryFilePath: string;
  try {
    memoryFilePath = safePath(workspacePath, MEMORY_RELATIVE);
  } catch (e: any) {
    return { success: false, output: `[SYSTEM SHIELD] ${e.message}` };
  }

  fs.mkdirSync(path.dirname(memoryFilePath), { recursive: true });

  const now = new Date();
  const timestamp = now.toISOString().replace('T', ' ').substring(0, 19);

  const entry =
    `\n### [${timestamp}] - Tarea: ${task_id.trim()}\n` +
    `**Outcome:** ${outcome}\n` +
    `**Lesson Learned:** ${lesson.trim()}\n`;

  fs.appendFileSync(memoryFilePath, entry, 'utf-8');

  return {
    success: true,
    output: `Decision log entry appended to ${MEMORY_RELATIVE}. Timestamp: ${timestamp}. Outcome: ${outcome}.`,
  };
}
