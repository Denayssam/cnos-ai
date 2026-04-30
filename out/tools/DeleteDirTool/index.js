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
exports.TOOL_DEF = void 0;
exports.execute = execute;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const shared_1 = require("../shared");
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'delete_dir',
        description: 'Delete a directory and all its contents recursively. Safer than run_command for deletions.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path to the directory to delete.' },
            },
            required: ['path'],
        },
    },
};
// ── Shield Patch (v8.10.0) — critical path validation ─────────────────────────
function validateDeletionPath(resolvedPath, workspacePath) {
    const resolvedWs = path.resolve(workspacePath);
    const rel = path.relative(resolvedWs, resolvedPath).replace(/\\/g, '/');
    // Block workspace root itself
    if (resolvedPath.toLowerCase() === resolvedWs.toLowerCase()) {
        return 'SHIELD BLOCKED: Cannot delete the workspace root directory.';
    }
    // Block .git directory (whole tree or any subdirectory inside it)
    if (rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.git\\')) {
        return `SHIELD BLOCKED: Deleting the .git directory is forbidden. Path: ${rel}`;
    }
    // Block node_modules only when path IS node_modules at the workspace root
    // (allow sub-package deletions inside nested node_modules)
    if (rel === 'node_modules') {
        return 'SHIELD BLOCKED: Deleting node_modules via agent is forbidden. Run "npm install" to restore it.';
    }
    return null;
}
function execute(args, workspacePath) {
    const dp = (0, shared_1.safePath)(workspacePath, args.path);
    const shieldError = validateDeletionPath(dp, workspacePath);
    if (shieldError) {
        return { success: false, output: shieldError };
    }
    if (!fs.existsSync(dp)) {
        return { success: false, output: `Directory not found: ${args.path}` };
    }
    fs.rmSync(dp, { recursive: true, force: true });
    return { success: true, output: `Directory and contents deleted: ${args.path}` };
}
//# sourceMappingURL=index.js.map