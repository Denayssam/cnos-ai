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
const MAX_REPO_MAP_CHARS = 15000;
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
// ─── Directory Walker ─────────────────────────────────────────────────────────
function scanDir(dirPath, workspacePath, blocks) {
    let entries;
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name)) {
            continue;
        }
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            scanDir(fullPath, workspacePath, blocks);
        }
        else if (entry.isFile() && TARGET_EXTS.has(path.extname(entry.name).toLowerCase())) {
            try {
                const relPath = path.relative(workspacePath, fullPath).replace(/\\/g, '/');
                const sigs = extractSignatures(fullPath);
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
        scanDir(workspacePath, workspacePath, blocks);
        if (blocks.length === 0) {
            return '';
        }
        let result = blocks.join('\n');
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