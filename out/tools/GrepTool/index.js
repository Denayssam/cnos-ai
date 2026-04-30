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
        name: 'grep',
        description: `Search for a string or regex pattern across project files. Use this INSTEAD OF 'grep', 'findstr', or 'rg' in run_command.
Returns: file_path:line_number: matching_line for every match.
WHEN TO USE: Finding where a function is called, locating imports, tracking variable usage across the project.
RESTRICTION: Do NOT use grep to parse entire HTML/React structures or look for complex multi-line blocks. Use it only for simple string/variable searches. For structural analysis of components, use read_file or get_code_structure instead.
Examples:
  pattern: "handleSubmit"         → finds all usages of handleSubmit
  pattern: "import.*useAuth"      → finds all useAuth import lines
  pattern: "useState\\("          → finds all useState hooks`,
        parameters: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'Search string or JavaScript regex pattern. Strings are matched literally; regex metacharacters are supported (e.g. "import.*from", "const.*=.*useState").',
                },
                path_filter: {
                    type: 'string',
                    description: 'Optional glob pattern to limit which files to search (e.g. "src/**/*.ts", "**/*.jsx"). Omit to search all files.',
                },
                case_sensitive: {
                    type: 'boolean',
                    description: 'Whether the match is case-sensitive. Defaults to false.',
                },
            },
            required: ['pattern'],
        },
    },
};
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__', '.fluxo']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.pdf', '.zip', '.gz', '.tar', '.bak', '.vsix']);
// Inline glob-to-regex so GrepTool has no shared dependency on GlobTool
function globToRegex(pattern) {
    let r = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*' && pattern[i + 1] === '*') {
            r += '.*';
            i++;
            if (pattern[i + 1] === '/') {
                i++;
            }
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
    return new RegExp(`^${r}$`, 'i');
}
function searchFile(filePath, relPath, rx, results) {
    if (BINARY_EXT.has(path.extname(filePath).toLowerCase())) {
        return;
    }
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf-8');
    }
    catch {
        return;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && results.length < 500; i++) {
        if (rx.test(lines[i])) {
            results.push({ file: relPath, line: i + 1, content: lines[i].trim().slice(0, 200) });
        }
    }
}
function walkAndGrep(dir, root, fileFilter, searchRx, results, depth) {
    if (depth > 12 || results.length >= 500) {
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
            walkAndGrep(full, root, fileFilter, searchRx, results, depth + 1);
        }
        else if (!fileFilter || fileFilter.test(rel)) {
            searchFile(full, rel, searchRx, results);
        }
    }
}
function execute(args, workspacePath) {
    const patternStr = String(args.pattern || '').trim();
    if (!patternStr) {
        return { success: false, output: 'CRITICAL ERROR: "pattern" is required.' };
    }
    const flags = args.case_sensitive === true ? '' : 'i';
    let searchRx;
    try {
        searchRx = new RegExp(patternStr, flags);
    }
    catch {
        // Not valid regex — escape and treat as literal string
        const escaped = patternStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        searchRx = new RegExp(escaped, flags);
    }
    let fileFilter = null;
    if (typeof args.path_filter === 'string' && args.path_filter.trim()) {
        try {
            fileFilter = globToRegex(args.path_filter.trim());
        }
        catch { /* ignore bad filter */ }
    }
    const results = [];
    walkAndGrep(workspacePath, workspacePath, fileFilter, searchRx, results, 0);
    if (results.length === 0) {
        return {
            success: false,
            output: `No matches for "${patternStr}"${args.path_filter ? ` in "${args.path_filter}"` : ''}. Try a broader pattern or remove the path_filter.`,
        };
    }
    const truncated = results.length >= 500;
    const lines = (truncated ? results.slice(0, 500) : results)
        .map(r => `${r.file}:${r.line}: ${r.content}`)
        .join('\n');
    return {
        success: true,
        output: `grep("${patternStr}"): ${results.length} match(es)${truncated ? ' — first 500 shown' : ''}:\n\n${lines}`,
    };
}
//# sourceMappingURL=index.js.map