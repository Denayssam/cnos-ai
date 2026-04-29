"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_DEF = void 0;
exports.execute = execute;
const agentMailbox_1 = require("../../utils/agentMailbox");
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'send_message',
        description: `Send a context payload to another agent running in a parallel thread.
The payload is delivered silently — it does NOT appear as raw content in the user's chat UI.
The recipient will receive it as an injected context message on their next iteration.
Use this to share API schemas, file paths, partial results, or any structured data between agents.`,
        parameters: {
            type: 'object',
            properties: {
                to_agent: { type: 'string', description: 'ID of the recipient agent (e.g. "designer", "coder", "manager").' },
                from_agent: { type: 'string', description: 'Your own agent ID — so the recipient knows who sent the message.' },
                payload: { type: 'string', description: 'The data or context to deliver. Can be JSON, plain text, or structured notes.' },
            },
            required: ['to_agent', 'from_agent', 'payload'],
        },
    },
};
function execute(args, _workspacePath) {
    const toAgent = String(args.to_agent ?? '').trim();
    const fromAgent = String(args.from_agent ?? 'unknown').trim();
    const payload = String(args.payload ?? '').trim();
    if (!toAgent) {
        return { success: false, output: 'send_message: "to_agent" is required.' };
    }
    if (!payload) {
        return { success: false, output: 'send_message: "payload" cannot be empty.' };
    }
    agentMailbox_1.AgentMailbox.send(toAgent, fromAgent, payload);
    // The output here is the LLM's tool result AND the UI tooltip — keep it short.
    // The actual payload is stored silently in the mailbox, not echoed here.
    return {
        success: true,
        output: `Message queued for @${toAgent}. It will be injected into their context on the next iteration.`,
    };
}
//# sourceMappingURL=index.js.map