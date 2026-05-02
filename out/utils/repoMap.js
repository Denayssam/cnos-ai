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
exports.buildRepoMap = buildRepoMap;
const ts = __importStar(require("typescript"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// ─── RepoMap Generator (v8.12.0 — Semantic Awareness Phase 2: AST Edition) ────
// Produces a compressed semantic map using the TypeScript compiler AST.
// Output is Aider-style: each file on its own header line, exported symbols indented below.
// Agents consume this as a codebase topography atlas — no shell commands needed.
const IGNORE_DIRS = new Set([
    'node_modules', '.git', '.fluxo', 'dist', 'out', 'build',
    'coverage', '.vscode', '.nyc_output', '__pycache__', '.next',
    '.nuxt', 'vendor', 'tmp', 'temp', '.turbo', '.cache',
]);
const TARGET_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);
// v8.17.3: extra languages get a regex-based fallback so the panoramic view
// covers polyglot repos. Aider-style: even an approximate symbol list gives
// the agent enough structure to pick the right file before reading it.
const REGEX_EXTS = new Set(['.py', '.go', '.rs', '.java', '.rb', '.cs', '.php', '.kt', '.swift']);
const MAX_REPO_MAP_CHARS = 15000;
const MAX_TREE_ENTRIES = 250; // hard cap on directory tree summary lines
const MAX_TREE_DEPTH = 6;
// ─── AST Helpers ─────────────────────────────────────────────────────────────
function hasModifier(node, kind) {
    if (!ts.canHaveModifiers(node)) {
        return false;
    }
    return (ts.getModifiers(node) ?? []).some(m => m.kind === kind);
}
function paramNames(params) {
    if (params.length === 0) {
        return '';
    }
    if (params.length > 4) {
        return '…';
    }
    return params.map(p => {
        const name = ts.isIdentifier(p.name) ? p.name.text : p.name.getText();
        return p.dotDotDotToken ? `...${name}` : name;
    }).join(', ');
}
function retSuffix(node, src) {
    return node.type ? `: ${node.type.getText(src)}` : '';
}
// ─── Per-file Signature Extractor ────────────────────────────────────────────
function extractSignatures(filePath) {
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    }
    catch {
        return [];
    }
    // Skip minified files — single very long line with semicolons
    const sampleLine = content.slice(0, 500);
    if (sampleLine.length > 300 && sampleLine.indexOf('\n') === -1 && sampleLine.includes(';')) {
        return [];
    }
    let src;
    try {
        src = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    }
    catch {
        return [];
    }
    const sigs = [];
    ts.forEachChild(src, (node) => {
        // ── export [async] [default] function Name(...): ReturnType ───────────────
        if (ts.isFunctionDeclaration(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
            const name = node.name?.text ?? '(anonymous)';
            const async_ = hasModifier(node, ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
            const dflt = hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? 'default ' : '';
            const ps = paramNames(node.parameters);
            const rt = retSuffix(node, src);
            sigs.push(`  export ${dflt}${async_}function ${name}(${ps})${rt}`);
            return;
        }
        // ── export [default] class Name ──────────────────────────────────────────
        if (ts.isClassDeclaration(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
            const name = node.name?.text ?? '(anonymous)';
            const dflt = hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? 'default ' : '';
            sigs.push(`  export ${dflt}class ${name}`);
            return;
        }
        // ── export interface Name ─────────────────────────────────────────────────
        if (ts.isInterfaceDeclaration(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
            sigs.push(`  export interface ${node.name.text}`);
            return;
        }
        // ── export type Name ──────────────────────────────────────────────────────
        if (ts.isTypeAliasDeclaration(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
            sigs.push(`  export type ${node.name.text}`);
            return;
        }
        // ── export enum Name ─────────────────────────────────────────────────────
        if (ts.isEnumDeclaration(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
            sigs.push(`  export enum ${node.name.text}`);
            return;
        }
        // ── export const/let/var Name = [arrow | value] ──────────────────────────
        if (ts.isVariableStatement(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
            const flags = node.declarationList.flags;
            const kind = flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var';
            for (const decl of node.declarationList.declarations) {
                if (!ts.isIdentifier(decl.name)) {
                    continue;
                }
                const name = decl.name.text;
                const init = decl.initializer;
                if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
                    const ps = paramNames(init.parameters);
                    const rt = init.type ? ` => ${init.type.getText(src)}` : ' => …';
                    sigs.push(`  ${kind} ${name} = (${ps})${rt}`);
                }
                else {
                    const typeAnn = decl.type ? `: ${decl.type.getText(src)}` : '';
                    sigs.push(`  export ${kind} ${name}${typeAnn}`);
                }
            }
            return;
        }
        // ── export default SomeExpression ─────────────────────────────────────────
        if (ts.isExportAssignment(node) && !node.isExportEquals) {
            const expr = node.expression.getText(src);
            if (expr.length < 60) {
                sigs.push(`  export default ${expr}`);
            }
        }
    });
    return sigs;
}
// ─── Regex Extractors (v8.17.3 — Polyglot Fallback) ─────────────────────────
// Aider-style: when a file is not TypeScript/JavaScript we don't have an AST,
// but we can still surface top-level symbol names so the agent knows where to
// look BEFORE it reads the whole file. Regexes are intentionally permissive —
// false positives are far better than blind navigation.
const REGEX_BY_EXT = {
    '.py': [/^\s*(?:async\s+)?def\s+([a-zA-Z_][\w]*)\s*\(/gm, /^\s*class\s+([a-zA-Z_][\w]*)\b/gm],
    '.go': [/^func\s+(?:\([^)]*\)\s*)?([A-Z][\w]*)\s*\(/gm, /^type\s+([A-Z][\w]*)\b/gm],
    '.rs': [/^\s*pub\s+(?:async\s+)?fn\s+([a-zA-Z_][\w]*)/gm, /^\s*pub\s+(?:struct|enum|trait)\s+([A-Z][\w]*)/gm],
    '.java': [/^\s*public\s+(?:static\s+)?[\w<>\[\],\s]+\s+([a-zA-Z_][\w]*)\s*\(/gm, /^\s*public\s+(?:abstract\s+|final\s+)?(?:class|interface|enum)\s+([A-Z][\w]*)/gm],
    '.rb': [/^\s*def\s+([a-zA-Z_][\w]*[!?=]?)/gm, /^\s*class\s+([A-Z][\w]*)/gm, /^\s*module\s+([A-Z][\w]*)/gm],
    '.cs': [/^\s*public\s+(?:static\s+|async\s+|virtual\s+|override\s+)*[\w<>\[\],\s?]+\s+([A-Z][\w]*)\s*\(/gm, /^\s*public\s+(?:abstract\s+|sealed\s+)?(?:class|interface|record|struct|enum)\s+([A-Z][\w]*)/gm],
    '.php': [/^\s*(?:public|protected|private)?\s*function\s+([a-zA-Z_][\w]*)\s*\(/gm, /^\s*(?:abstract\s+|final\s+)?class\s+([A-Z][\w]*)/gm],
    '.kt': [/^\s*(?:public\s+|internal\s+)?fun\s+([a-zA-Z_][\w]*)\s*\(/gm, /^\s*(?:public\s+|internal\s+)?(?:open\s+|sealed\s+|data\s+|abstract\s+)?class\s+([A-Z][\w]*)/gm],
    '.swift': [/^\s*(?:public\s+|internal\s+|open\s+)?func\s+([a-zA-Z_][\w]*)/gm, /^\s*(?:public\s+|internal\s+|open\s+)?(?:class|struct|protocol|enum|actor)\s+([A-Z][\w]*)/gm],
};
function extractSignaturesRegex(filePath, ext) {
    const patterns = REGEX_BY_EXT[ext];
    if (!patterns) {
        return [];
    }
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    }
    catch {
        return [];
    }
    if (content.length > 200000) {
        return [];
    } // skip huge files
    const sigs = new Set();
    for (const re of patterns) {
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(content)) !== null && sigs.size < 40) {
            sigs.add(`  ${m[0].trim()}`);
        }
    }
    return Array.from(sigs);
}
function scanDir(dirPath, workspacePath, blocks, tree, depth) {
    let entries;
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    }
    catch {
        return;
    }
    // Stable order so the tree summary doesn't shuffle between calls
    entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
            return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name)) {
            continue;
        }
        const fullPath = path.join(dirPath, entry.name);
        const relPath = path.relative(workspacePath, fullPath).replace(/\\/g, '/');
        if (entry.isDirectory()) {
            if (tree.length < MAX_TREE_ENTRIES && depth <= MAX_TREE_DEPTH) {
                tree.push(`${'  '.repeat(depth)}${entry.name}/`);
            }
            scanDir(fullPath, workspacePath, blocks, tree, depth + 1);
        }
        else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            const isTarget = TARGET_EXTS.has(ext);
            const isRegex = REGEX_EXTS.has(ext);
            if (!isTarget && !isRegex) {
                continue;
            }
            try {
                const sigs = isTarget ? extractSignatures(fullPath) : extractSignaturesRegex(fullPath, ext);
                if (tree.length < MAX_TREE_ENTRIES && depth <= MAX_TREE_DEPTH) {
                    const tag = sigs.length > 0 ? ` (${sigs.length})` : '';
                    tree.push(`${'  '.repeat(depth)}${entry.name}${tag}`);
                }
                if (sigs.length > 0) {
                    blocks.push(`${relPath}:\n${sigs.join('\n')}`);
                }
                else {
                    blocks.push(relPath);
                }
            }
            catch { /* skip unreadable entries silently */ }
        }
    }
}
// ─── Public API ──────────────────────────────────────────────────────────────
function buildRepoMap(workspacePath) {
    if (!workspacePath) {
        return '';
    }
    try {
        const blocks = [];
        const tree = [];
        scanDir(workspacePath, workspacePath, blocks, tree, 0);
        if (blocks.length === 0 && tree.length === 0) {
            return '';
        }
        // v8.17.3: Aider-style panoramic header — directory tree above the symbol
        // detail blocks. Agents reading just the first N chars still get a
        // navigable map of the whole codebase.
        const header = tree.length > 0
            ? `── DIRECTORY TREE (depth ≤ ${MAX_TREE_DEPTH}, parens = symbol count) ──\n${tree.join('\n')}\n\n── FILE SYMBOLS ──\n`
            : '';
        let result = header + blocks.join('\n');
        if (result.length > MAX_REPO_MAP_CHARS) {
            result = result.substring(0, MAX_REPO_MAP_CHARS) +
                '\n[repo_map truncated — showing partial structure]';
        }
        return result;
    }
    catch {
        return '';
    }
}
//# sourceMappingURL=repoMap.js.map