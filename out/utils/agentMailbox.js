"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentMailbox = void 0;
class AgentMailboxClass {
    constructor() {
        this.inbox = new Map();
    }
    send(toAgentId, fromAgentId, payload) {
        const key = toAgentId.toLowerCase().trim();
        if (!this.inbox.has(key)) {
            this.inbox.set(key, []);
        }
        this.inbox.get(key).push({ fromAgentId, payload, sentAt: Date.now() });
    }
    // Consume and return all messages for an agent (empties the inbox slot).
    drain(agentId) {
        const key = agentId.toLowerCase().trim();
        const entries = this.inbox.get(key);
        if (!entries || entries.length === 0) {
            return [];
        }
        this.inbox.delete(key);
        return entries.map(e => `[FROM @${e.fromAgentId}]: ${e.payload}`);
    }
    hasPending(agentId) {
        const entries = this.inbox.get(agentId.toLowerCase().trim());
        return !!(entries && entries.length > 0);
    }
}
exports.AgentMailbox = new AgentMailboxClass();
//# sourceMappingURL=agentMailbox.js.map