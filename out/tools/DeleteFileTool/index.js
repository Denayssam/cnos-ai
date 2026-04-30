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
        name: 'delete_file',
        description: 'Delete a single file from the workspace. Safer than run_command for deletions.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path to the file to delete.' },
            },
            required: ['path'],
        },
    },
};
// ── Shield Patch (v8.10.0) — critical path validation ─────────────────────────
function validateDeletionPath(resolvedPath, workspacePath) {
    const rel = path.relative(workspacePath, resolvedPath).replace(/\\/g, '/');
    // Block .git directory contents
    if (rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.git\\')) {
        return `SHIELD BLOCKED: Deleting inside .git is forbidden. Path: ${rel}`;
    }
    // Block deletion of workspace root itself
    if (resolvedPath.toLowerCase() === path.resolve(workspacePath).toLowerCase()) {
        return 'SHIELD BLOCKED: Cannot delete the workspace root.';
    }
    return null;
}
function execute(args, workspacePath) {
    const fp = (0, shared_1.safePath)(workspacePath, args.path);
    const shieldError = validateDeletionPath(fp, workspacePath);
    if (shieldError) {
        return { success: false, output: shieldError };
    }
    if (!fs.existsSync(fp)) {
        return { success: false, output: `File not found: ${args.path}` };
    }
    fs.unlinkSync(fp);
    return { success: true, output: `Deleted: ${args.path}` };
}
//# sourceMappingURL=index.js.map