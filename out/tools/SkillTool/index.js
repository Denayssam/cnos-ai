"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_DEF = void 0;
exports.execute = execute;
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'skill',
        description: 'Access the Community Skills library — pre-built implementation recipes for common integrations. ' +
            'Use action="list" to see available skills. ' +
            'Use action="apply" with a skill_name to inject the recipe into .fluxo/IMPLEMENTATION_PLAN.md ' +
            'and skip manual planning for well-known tasks (e.g. stripe-payment-flow, firebase-auth, etc.).',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['list', 'apply'],
                    description: '"list" returns all available skills. "apply" injects a skill recipe into the implementation plan.',
                },
                skill_name: {
                    type: 'string',
                    description: 'The skill name to apply (required when action="apply"). Use the exact name returned by action="list".',
                },
            },
            required: ['action'],
        },
    },
};
function execute(_args, _workspacePath) {
    return {
        success: false,
        output: '[SYSTEM]: skill is intercepted by the engine. This execute() body should never run.',
    };
}
//# sourceMappingURL=index.js.map