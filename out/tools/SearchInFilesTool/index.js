"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_DEF = void 0;
exports.execute = execute;
const shared_1 = require("../shared");
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'search_in_files',
        description: 'Search for a text pattern across workspace files. Returns matching file:line results.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'The text pattern to search for (case-insensitive).' },
                directory: { type: 'string', description: 'Subdirectory to restrict the search. Defaults to workspace root.' },
            },
            required: ['pattern'],
        },
    },
};
function execute(args, workspacePath) {
    const searchRoot = (0, shared_1.safePath)(workspacePath, args.directory || '.');
    const results = [];
    (0, shared_1.searchRecursive)(searchRoot, workspacePath, String(args.pattern || ''), results, 0);
    if (results.length === 0) {
        return { success: true, output: 'No matches found.' };
    }
    return { success: true, output: results.slice(0, 60).join('\n') };
}
//# sourceMappingURL=index.js.map