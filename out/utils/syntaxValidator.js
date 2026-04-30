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
exports.checkSyntax = checkSyntax;
const ts = __importStar(require("typescript"));
const path = __importStar(require("path"));
// ─── AST Syntax Validator (v8.14.0 — Syntax Shield) ──────────────────────────
// Validates TS/JS/TSX/JSX content in-memory using the TypeScript compiler.
// No real filesystem access — uses a virtual CompilerHost.
// Returns immediately (ok: true) for non-JS/TS file types.
const CHECKABLE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);
function checkSyntax(filePath, content) {
    const ext = path.extname(filePath).toLowerCase();
    if (!CHECKABLE_EXTS.has(ext)) {
        return { ok: true, errors: '' };
    }
    // Virtual path avoids Windows normalization issues and real-FS lookups.
    // The extension is preserved so the compiler applies correct JSX rules.
    const virtualPath = `__fluxo_virtual__${ext}`;
    const compilerHost = {
        getSourceFile: (name) => {
            if (name === virtualPath) {
                return ts.createSourceFile(virtualPath, content, ts.ScriptTarget.Latest, true);
            }
            return undefined;
        },
        writeFile: () => { },
        getDefaultLibFileName: () => 'lib.d.ts',
        useCaseSensitiveFileNames: () => false,
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => '',
        getNewLine: () => '\n',
        fileExists: (name) => name === virtualPath,
        readFile: () => '',
        directoryExists: () => false,
        getDirectories: () => [],
    };
    try {
        const program = ts.createProgram([virtualPath], {
            noResolve: true,
            target: ts.ScriptTarget.Latest,
            allowJs: true,
            jsx: ts.JsxEmit.React,
            noLib: true,
        }, compilerHost);
        const sourceFile = program.getSourceFile(virtualPath);
        if (!sourceFile) {
            return { ok: true, errors: '' };
        }
        const diagnostics = program.getSyntacticDiagnostics(sourceFile);
        if (diagnostics.length === 0) {
            return { ok: true, errors: '' };
        }
        const errors = [...diagnostics]
            .slice(0, 5) // cap output — avoid wall-of-text on catastrophic failures
            .map(d => {
            const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
            if (d.file && d.start !== undefined) {
                const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
                return `  Line ${line + 1}, Col ${character + 1}: ${msg}`;
            }
            return `  ${msg}`;
        })
            .join('\n');
        return { ok: false, errors };
    }
    catch {
        // Validator crash must never block a write — fail open
        return { ok: true, errors: '' };
    }
}
//# sourceMappingURL=syntaxValidator.js.map