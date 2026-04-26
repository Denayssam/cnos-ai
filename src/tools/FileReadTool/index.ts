import * as fs from 'fs';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read the full contents of a file. Each line is prefixed with its 1-based line number. Use this before edit_file to see the exact text to replace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file relative to the workspace root.' },
      },
      required: ['path'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const fp = safePath(workspacePath, args.path);
  if (!fs.existsSync(fp)) {
    const parentDir = (args.path as string || '.').split('/').slice(0, -1).join('/') || '.';
    return {
      success: false,
      output: [
        `FILE NOT FOUND: "${args.path}"`,
        ``,
        `MANDATORY NEXT STEP: Call list_dir BEFORE any further read_file attempts.`,
        `  Suggested target: list_dir on "${parentDir}"`,
        `DO NOT retry read_file on guessed paths. Discover the actual structure first.`,
      ].join('\n'),
    };
  }

  const buffer = fs.readFileSync(fp);
  let content: string;

  // Detect UTF-16LE (BOM: FF FE) or generic binary with null bytes
  if (buffer.length > 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    content = buffer.toString('utf16le');
  } else if (buffer.indexOf(0) !== -1) {
    // Strip null bytes from other encodings to avoid API errors
    content = buffer.toString('utf-8').replace(/\0/g, '');
  } else {
    content = buffer.toString('utf-8');
  }

  const truncated = content.length > 60_000
    ? content.slice(0, 60_000) + '\n...[truncated at 60KB]'
    : content;
  const numbered = truncated.split('\n').map((line, i) => `${i + 1} | ${line}`).join('\n');
  return { success: true, output: numbered };
}
