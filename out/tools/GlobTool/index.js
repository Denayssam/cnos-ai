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
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'glob',
        description: `Find files in the workspace matching a glob pattern. Use this INSTEAD OF 'ls', 'find', or 'dir' in run_command.
Patterns: ** = any depth, * = any chars (no slash), ? = single char.
Examples:
  "src/**/*.tsx"     → all TSX files under src/
  "**/*.test.ts"     → all test files
  "components/*.jsx" → JSX files in one folder
  "**/*.{ts,tsx}"    → TS and TSX files anywhere`,
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Glob pattern relative to workspace root. Use forward slashes.' },
                cwd: { type: 'string', description: 'Optional subdirectory to search within (relative to workspace root). Defaults to workspace root.' },
            },
            required: ['pattern'],
        },
    },
};
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__', '.fluxo']);
function globToRegex(pattern) {
    let r = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*' && pattern[i + 1] === '*') {
            r += '.*';
            i++;
            if (pattern[i + 1] === '/') {
                i++;
            } // consume the slash after **
        }
        else if (c === '*') {
            r += '[^/]*';
        }
        else if (c === '?') {
            r += '[^/]';
        }
        else if ('.+^${}()|[]\\'.includes(c)) {
            r += '\\' + c;
        }
        else {
            r += c;
        }
    }
    return new RegExp(`^${r}$`, 'i'); // case-insensitive for Windows compat
}
function walkAndMatch(dir, root, regex, results, depth) {
    if (depth > 12 || results.length >= 300) {
        return;
    }
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) {
            continue;
        }
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full).replace(/\\/g, '/');
        if (entry.isDirectory()) {
            walkAndMatch(full, root, regex, results, depth + 1);
        }
        else if (regex.test(rel)) {
            results.push(rel);
        }
    }
}
function execute(args, workspacePath) {
    const pattern = String(args.pattern || '').trim();
    if (!pattern) {
        return { success: false, output: 'CRITICAL ERROR: "pattern" is required. Example: "src/**/*.tsx".' };
    }
    let searchRoot = workspacePath;
    if (typeof args.cwd === 'string' && args.cwd.trim()) {
        searchRoot = path.join(workspacePath, args.cwd.trim());
        if (!fs.existsSync(searchRoot)) {
            return { success: false, output: `Directory not found: "${args.cwd}". Use list_dir('.') to verify the workspace structure.` };
        }
    }
    let regex;
    try {
        regex = globToRegex(pattern);
    }
    catch {
        return { success: false, output: `Invalid glob pattern: "${pattern}".` };
    }
    const results = [];
    walkAndMatch(searchRoot, workspacePath, regex, results, 0);
    if (results.length === 0) {
        return {
            success: false,
            output: `No files matched "${pattern}". Try a broader pattern (e.g. "**/*.tsx") or verify the directory with list_dir('.').`,
        };
    }
    const truncated = results.length >= 300;
    return {
        success: true,
        output: `glob("${pattern}"): ${results.length} file(s) found${truncated ? ' — first 300 shown' : ''}:\n\n${(truncated ? results.slice(0, 300) : results).join('\n')}`,
    };
}
//# sourceMappingURL=index.js.map