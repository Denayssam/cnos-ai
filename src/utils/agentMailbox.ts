interface MailboxEntry {
  fromAgentId: string;
  payload: string;
  sentAt: number;
}

class AgentMailboxClass {
  private inbox = new Map<string, MailboxEntry[]>();

  send(toAgentId: string, fromAgentId: string, payload: string): void {
    const key = toAgentId.toLowerCase().trim();
    if (!this.inbox.has(key)) { this.inbox.set(key, []); }
    this.inbox.get(key)!.push({ fromAgentId, payload, sentAt: Date.now() });
  }

  // Consume and return all messages for an agent (empties the inbox slot).
  drain(agentId: string): string[] {
    const key = agentId.toLowerCase().trim();
    const entries = this.inbox.get(key);
    if (!entries || entries.length === 0) { return []; }
    this.inbox.delete(key);
    return entries.map(e => `[FROM @${e.fromAgentId}]: ${e.payload}`);
  }

  hasPending(agentId: string): boolean {
    const entries = this.inbox.get(agentId.toLowerCase().trim());
    return !!(entries && entries.length > 0);
  }
}

export const AgentMailbox = new AgentMailboxClass();
