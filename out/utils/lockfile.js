"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileLockManager = void 0;
class FileLockManagerClass {
    constructor() {
        this.locks = new Map();
    }
    // Returns true if the lock was acquired (or is already held by the same agent).
    // Returns false if the file is locked by a different agent.
    acquireLock(filePath, agentId) {
        const key = filePath.toLowerCase();
        const existing = this.locks.get(key);
        if (existing) {
            return existing.agentId === agentId; // reentrant for same agent
        }
        this.locks.set(key, { agentId, acquiredAt: Date.now() });
        return true;
    }
    // Releases the lock only if the caller is the current holder.
    releaseLock(filePath, agentId) {
        const key = filePath.toLowerCase();
        const existing = this.locks.get(key);
        if (existing && existing.agentId === agentId) {
            this.locks.delete(key);
        }
    }
    getHolder(filePath) {
        return this.locks.get(filePath.toLowerCase())?.agentId;
    }
}
exports.FileLockManager = new FileLockManagerClass();
//# sourceMappingURL=lockfile.js.map