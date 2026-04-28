// Powered by Fluxo Tech AI — https://fluxotechai.com
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'fetch_documentation',
    description:
      'Fetches the content of an external URL (e.g. a GitHub README, npm package page, or official documentation) ' +
      'and returns it as clean plain text. Use this BEFORE writing any code that depends on an external library, ' +
      'to read the real, up-to-date API instead of relying on training memory. ' +
      'Ideal for: GitHub raw README files, npm package pages, official docs sites. ' +
      'The response is automatically cleaned (scripts, nav, and styles removed) and truncated to 20,000 characters.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'The full URL to fetch. Prefer raw content URLs when available ' +
            '(e.g. https://raw.githubusercontent.com/user/repo/main/README.md). ' +
            'For npm packages use https://www.npmjs.com/package/<name>.',
        },
      },
      required: ['url'],
    },
  },
};

/**
 * Sync stub — this tool requires an async HTTP fetch.
 * The actual execution is handled in agentEngine.ts via the fetchDocumentationCallback path.
 * This stub is only reached if the engine falls through to executeTool() unexpectedly.
 */
export function execute(_args: Record<string, any>, _workspacePath: string): ToolResult {
  return {
    success: false,
    output:
      '[SYSTEM ERROR] fetch_documentation requires async execution. ' +
      'This stub should never be called directly — the engine routes it via fetchDocumentationCallback.',
  };
}
