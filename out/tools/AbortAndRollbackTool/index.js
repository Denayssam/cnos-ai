"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_DEF = void 0;
exports.execute = execute;
const gitSafety_1 = require("../../utils/gitSafety");
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'abort_and_rollback',
        description: 'Use this tool ONLY if you realize your edits have fundamentally broken the project\'s logic, ' +
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
function execute(args, workspacePath) {
    return (0, gitSafety_1.rollbackToLastCheckpoint)(workspacePath);
}
//# sourceMappingURL=index.js.map