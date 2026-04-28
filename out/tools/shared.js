"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.safePath = safePath;
exports.searchRecursive = searchRecursive;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// ─── Shared Helpers ───────────────────────────────────────────────────────────
function safePath(workspacePath, p) {
    if (!p) {
        throw new Error('Path is required');
    }
    // ── Robust Path Sanitization (v7.14.0) ──────────────────────────────
    // Handles ALL known LLM path hallucinations:
    //   1. Docker-bias:   /workspace/src/file.tsx
    //   2. Overlap:       /workspace/d:\real\path\file.tsx  (Docker prefix + Windows absolute)
    //   3. Pure relative: src/file.tsx
    //   4. Pure absolute: d:\real\path\file.tsx (valid if inside workspace)
    let clean = p;
    if (clean.startsWith('/workspace/')) {
        clean = clean.substring(11);
    }
    else if (clean.startsWith('workspace/')) {
        clean = clean.substring(10);
    }
    else if (clean.startsWith('\\workspace\\')) {
        clean = clean.substring(11);
    }
    const driveIndex = clean.search(/[a-zA-Z]:/);
    if (driveIndex > 0) {
        clean = clean.substring(driveIndex);
    }
    clean = path.normalize(clean);
    // Resolve to an absolute path
    const resolvedWs = path.resolve(workspacePath);
    const resolvedClean = path.resolve(workspacePath, clean);
    // Case-insensitive comparison on Windows to ensure we are within the workspace root
    if (!resolvedClean.toLowerCase().startsWith(resolvedWs.toLowerCase())) {
        throw new Error(`Path traversal blocked or outside workspace: ${p}`);
    }
    return resolvedClean;
}
function searchRecursive(dir, root, pattern, results, depth) {
    if (depth > 6 || results.length > 100) {
        return;
    }
    const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__']);
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (SKIP.has(entry.name)) {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            searchRecursive(full, root, pattern, results, depth + 1);
        }
        else {
            try {
                const content = fs.readFileSync(full, 'utf-8');
                const lowerContent = content.toLowerCase();
                const lowerPattern = pattern.toLowerCase();
                if (lowerContent.includes(lowerPattern)) {
                    const lines = content.split('\n');
                    lines.forEach((line, i) => {
                        if (line.toLowerCase().includes(lowerPattern)) {
                            results.push(`${path.relative(root, full)}:${i + 1}: ${line.trim().slice(0, 120)}`);
                        }
                    });
                }
            }
            catch { /* binary file */ }
        }
    }
}
//# sourceMappingURL=shared.js.map