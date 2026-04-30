import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

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
const MAX_REPO_MAP_CHARS = 15_000;

// ─── AST Helpers ─────────────────────────────────────────────────────────────

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) { return false; }
  return (ts.getModifiers(node) ?? []).some(m => m.kind === kind);
}

function paramNames(params: ts.NodeArray<ts.ParameterDeclaration>): string {
  if (params.length === 0) { return ''; }
  if (params.length > 4) { return '…'; }
  return params.map(p => {
    const name = ts.isIdentifier(p.name) ? p.name.text : p.name.getText();
    return p.dotDotDotToken ? `...${name}` : name;
  }).join(', ');
}

function retSuffix(node: { type?: ts.TypeNode }, src: ts.SourceFile): string {
  return node.type ? `: ${node.type.getText(src)}` : '';
}

// ─── Per-file Signature Extractor ────────────────────────────────────────────

function extractSignatures(filePath: string): string[] {
  let content: string;
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

  // Skip minified files — single very long line with semicolons
  const sampleLine = content.slice(0, 500);
  if (sampleLine.length > 300 && sampleLine.indexOf('\n') === -1 && sampleLine.includes(';')) { return []; }

  let src: ts.SourceFile;
  try {
    src = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  } catch { return []; }

  const sigs: string[] = [];

  ts.forEachChild(src, (node) => {

    // ── export [async] [default] function Name(...): ReturnType ───────────────
    if (ts.isFunctionDeclaration(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      const name   = node.name?.text ?? '(anonymous)';
      const async_ = hasModifier(node, ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
      const dflt   = hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? 'default ' : '';
      const ps     = paramNames(node.parameters);
      const rt     = retSuffix(node, src);
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
      const kind  = flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var';
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) { continue; }
        const name = decl.name.text;
        const init = decl.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          const ps = paramNames(init.parameters);
          const rt = init.type ? ` => ${init.type.getText(src)}` : ' => …';
          sigs.push(`  ${kind} ${name} = (${ps})${rt}`);
        } else {
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

function scanDir(dirPath: string, workspacePath: string, blocks: string[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) { continue; }
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      scanDir(fullPath, workspacePath, blocks);
    } else if (entry.isFile() && TARGET_EXTS.has(path.extname(entry.name).toLowerCase())) {
      try {
        const relPath = path.relative(workspacePath, fullPath).replace(/\\/g, '/');
        const sigs = extractSignatures(fullPath);
        if (sigs.length > 0) {
          blocks.push(`${relPath}:\n${sigs.join('\n')}`);
        } else {
          blocks.push(relPath);
        }
      } catch { /* skip unreadable entries silently */ }
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function buildRepoMap(workspacePath: string): string {
  if (!workspacePath) { return ''; }
  try {
    const blocks: string[] = [];
    scanDir(workspacePath, workspacePath, blocks);
    if (blocks.length === 0) { return ''; }

    let result = blocks.join('\n');

    if (result.length > MAX_REPO_MAP_CHARS) {
      result = result.substring(0, MAX_REPO_MAP_CHARS) +
        '\n[repo_map truncated — showing partial structure]';
    }

    return result;
  } catch {
    return '';
  }
}
