import * as fs from 'fs';
import * as path from 'path';

// ─── Shared Types ─────────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean;
  output: string;
}

export interface NativeTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      // Permissive to support array schemas (items, enum, etc.) alongside simple { type, description } entries.
      properties: Record<string, any>;
      required: string[];
    };
  };
}

// ─── Shared Helpers ───────────────────────────────────────────────────────────

// ─── Absolute Path Shield (v8.18.1) ─────────────────────────────────────────
// Phase 4 dogfooding revealed the LLM hallucinating Windows-absolute paths
// like C:/Users/erick/source/repos/... when reading or analyzing files. The
// guard rejects ANY path that starts with a drive letter (Windows: C:/ or
// C:\) or with a leading slash (POSIX: /home/...) BEFORE the tool reaches
// any filesystem call. Returns null when the path is acceptable, or a
// ToolResult error when it must be rejected. Tools call this at the very
// top of execute() so the rejection is uniform and the error message is
// the verbatim user-spec string.
const ABSOLUTE_PATH_REGEX = /^(?:[A-Za-z]:[\\/]|\/)/;

export function rejectIfAbsolutePath(rawPath: unknown): ToolResult | null {
  if (typeof rawPath !== 'string') { return null; }
  const trimmed = rawPath.trim();
  if (!trimmed) { return null; }
  if (ABSOLUTE_PATH_REGEX.test(trimmed)) {
    return {
      success: false,
      output:
        '[SYSTEM SHIELD] Absolute paths are strictly forbidden. ' +
        "You MUST use relative paths from the repository root (e.g., 'src/components/App.jsx').",
    };
  }
  return null;
}
// ────────────────────────────────────────────────────────────────────────────

export function safePath(workspacePath: string, p: string): string {
  if (!p) { throw new Error('Path is required'); }

  // ── Robust Path Sanitization (v7.14.0) ──────────────────────────────
  // Handles ALL known LLM path hallucinations:
  //   1. Docker-bias:   /workspace/src/file.tsx
  //   2. Overlap:       /workspace/d:\real\path\file.tsx  (Docker prefix + Windows absolute)
  //   3. Pure relative: src/file.tsx
  //   4. Pure absolute: d:\real\path\file.tsx (valid if inside workspace)
  let clean = p;
  if (clean.startsWith('/workspace/'))     { clean = clean.substring(11); }
  else if (clean.startsWith('workspace/')) { clean = clean.substring(10); }
  else if (clean.startsWith('\\workspace\\')) { clean = clean.substring(11); }

  const driveIndex = clean.search(/[a-zA-Z]:/);
  if (driveIndex > 0) {
    clean = clean.substring(driveIndex);
  }

  clean = path.normalize(clean);

  // Resolve to an absolute path
  const resolvedWs    = path.resolve(workspacePath);
  const resolvedClean = path.resolve(workspacePath, clean);

  // Case-insensitive comparison on Windows to ensure we are within the workspace root
  if (!resolvedClean.toLowerCase().startsWith(resolvedWs.toLowerCase())) {
    throw new Error(`Path traversal blocked or outside workspace: ${p}`);
  }

  return resolvedClean;
}

export function searchRecursive(
  dir: string,
  root: string,
  pattern: string,
  results: string[],
  depth: number
): void {
  if (depth > 6 || results.length > 100) { return; }
  const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__']);

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (SKIP.has(entry.name)) { continue; }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      searchRecursive(full, root, pattern, results, depth + 1);
    } else {
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
      } catch { /* binary file */ }
    }
  }
}
