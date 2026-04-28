"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_DEF = void 0;
exports.execute = execute;
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'fetch_documentation',
        description: 'Fetches the content of an external URL (e.g. a GitHub README, npm package page, or official documentation) ' +
            'and returns it as clean plain text. Use this BEFORE writing any code that depends on an external library, ' +
            'to read the real, up-to-date API instead of relying on training memory. ' +
            'Ideal for: GitHub raw README files, npm package pages, official docs sites. ' +
            'The response is automatically cleaned (scripts, nav, and styles removed) and truncated to 20,000 characters.',
        parameters: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: 'The full URL to fetch. Prefer raw content URLs when available ' +
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
function execute(_args, _workspacePath) {
    return {
        success: false,
        output: '[SYSTEM ERROR] fetch_documentation requires async execution. ' +
            'This stub should never be called directly — the engine routes it via fetchDocumentationCallback.',
    };
}
//# sourceMappingURL=index.js.map