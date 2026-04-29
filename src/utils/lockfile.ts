interface LockEntry {
  agentId: string;
  acquiredAt: number;
}

class FileLockManagerClass {
  private locks = new Map<string, LockEntry>();

  // Returns true if the lock was acquired (or is already held by the same agent).
  // Returns false if the file is locked by a different agent.
  acquireLock(filePath: string, agentId: string): boolean {
    const key = filePath.toLowerCase();
    const existing = this.locks.get(key);
    if (existing) {
      return existing.agentId === agentId; // reentrant for same agent
    }
    this.locks.set(key, { agentId, acquiredAt: Date.now() });
    return true;
  }

  // Releases the lock only if the caller is the current holder.
  releaseLock(filePath: string, agentId: string): void {
    const key = filePath.toLowerCase();
    const existing = this.locks.get(key);
    if (existing && existing.agentId === agentId) {
      this.locks.delete(key);
    }
  }

  getHolder(filePath: string): string | undefined {
    return this.locks.get(filePath.toLowerCase())?.agentId;
  }
}

export const FileLockManager = new FileLockManagerClass();
