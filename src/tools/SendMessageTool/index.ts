import { NativeTool, ToolResult } from '../shared';
import { AgentMailbox } from '../../utils/agentMailbox';

export const TOOL_DEF: NativeTool = {
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
        to_agent:   { type: 'string', description: 'ID of the recipient agent (e.g. "designer", "coder", "manager").' },
        from_agent: { type: 'string', description: 'Your own agent ID — so the recipient knows who sent the message.' },
        payload:    { type: 'string', description: 'The data or context to deliver. Can be JSON, plain text, or structured notes.' },
      },
      required: ['to_agent', 'from_agent', 'payload'],
    },
  },
};

export function execute(args: Record<string, any>, _workspacePath: string): ToolResult {
  const toAgent   = String(args.to_agent   ?? '').trim();
  const fromAgent = String(args.from_agent ?? 'unknown').trim();
  const payload   = String(args.payload    ?? '').trim();

  if (!toAgent) {
    return { success: false, output: 'send_message: "to_agent" is required.' };
  }
  if (!payload) {
    return { success: false, output: 'send_message: "payload" cannot be empty.' };
  }

  AgentMailbox.send(toAgent, fromAgent, payload);
  // The output here is the LLM's tool result AND the UI tooltip — keep it short.
  // The actual payload is stored silently in the mailbox, not echoed here.
  return {
    success: true,
    output: `Message queued for @${toAgent}. It will be injected into their context on the next iteration.`,
  };
}
