"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_DEF = void 0;
exports.execute = execute;
const repoMap_1 = require("../../utils/repoMap");
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'get_repo_map',
        description: 'Generates a compressed semantic AST map of the entire repository. ' +
            'Use this tool FIRST when exploring a codebase to instantly know where components, functions, and classes are defined ' +
            'without guessing file paths. ' +
            'Returns a multi-line map: each file on its own header line, with its exported symbols indented below it. ' +
            'After calling this, you can navigate directly to any symbol with read_file or replace_symbol.',
        parameters: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
};
function execute(_args, workspacePath) {
    const map = (0, repoMap_1.buildRepoMap)(workspacePath);
    if (!map) {
        return {
            success: false,
            output: 'No mappable source files found. Try list_dir(".") to explore the workspace structure manually.',
        };
    }
    return { success: true, output: `REPO MAP:\n\n${map}` };
}
//# sourceMappingURL=index.js.map