import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult } from '../shared';

const MEMORY_PATH = '.fluxo/memory.md';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'update_memory',
    description:
      'Create or overwrite the workspace memory file (.fluxo/memory.md). ' +
      'Use this tool when the user explicitly asks you to "remember" a rule, preference, or convention, ' +
      'OR when you and the user agree on an important architectural decision that should persist across sessions. ' +
      'Always include the full desired memory content — this overwrites the file completely. ' +
      'Read the existing memory first (if any) so you can merge old rules with new ones before writing.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description:
            'Full markdown content for .fluxo/memory.md. Use headings (##) to organize rules by category. ' +
            'Example sections: ## Coding Conventions, ## Architecture Decisions, ## User Preferences.',
        },
      },
      required: ['content'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  if (typeof args.content !== 'string' || args.content.trim() === '') {
    return { success: false, output: 'CRITICAL ERROR: "content" is missing or empty.' };
  }
  const memoryFilePath = path.join(workspacePath, MEMORY_PATH);
  fs.mkdirSync(path.dirname(memoryFilePath), { recursive: true });
  fs.writeFileSync(memoryFilePath, args.content, 'utf-8');
  const size = Buffer.byteLength(args.content, 'utf-8');
  return {
    success: true,
    output: `Workspace memory updated: ${MEMORY_PATH} (${size} bytes). Rules will be injected into all agents on the next session.`,
  };
}
