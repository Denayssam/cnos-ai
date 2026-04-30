import * as ts from 'typescript';
import * as path from 'path';

// ─── AST Syntax Validator (v8.14.0 — Syntax Shield) ──────────────────────────
// Validates TS/JS/TSX/JSX content in-memory using the TypeScript compiler.
// No real filesystem access — uses a virtual CompilerHost.
// Returns immediately (ok: true) for non-JS/TS file types.

const CHECKABLE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);

export interface SyntaxCheckResult {
  ok: boolean;
  errors: string;
}

export function checkSyntax(filePath: string, content: string): SyntaxCheckResult {
  const ext = path.extname(filePath).toLowerCase();
  if (!CHECKABLE_EXTS.has(ext)) { return { ok: true, errors: '' }; }

  // Virtual path avoids Windows normalization issues and real-FS lookups.
  // The extension is preserved so the compiler applies correct JSX rules.
  const virtualPath = `__fluxo_virtual__${ext}`;

  const compilerHost: ts.CompilerHost = {
    getSourceFile: (name) => {
      if (name === virtualPath) {
        return ts.createSourceFile(virtualPath, content, ts.ScriptTarget.Latest, true);
      }
      return undefined;
    },
    writeFile: () => {},
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
    const program = ts.createProgram(
      [virtualPath],
      {
        noResolve: true,
        target: ts.ScriptTarget.Latest,
        allowJs: true,
        jsx: ts.JsxEmit.React,
        noLib: true,
      },
      compilerHost
    );
    const sourceFile = program.getSourceFile(virtualPath);
    if (!sourceFile) { return { ok: true, errors: '' }; }

    const diagnostics = program.getSyntacticDiagnostics(sourceFile);
    if (diagnostics.length === 0) { return { ok: true, errors: '' }; }

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
  } catch {
    // Validator crash must never block a write — fail open
    return { ok: true, errors: '' };
  }
}
