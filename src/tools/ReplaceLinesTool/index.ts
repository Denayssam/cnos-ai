import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'replace_lines',
    description: `Replace an exact range of lines in a file using coordinate-based targeting.
MANDATORY WORKFLOW: (1) Call read_file to get current line numbers. (2) Identify start_line and end_line for the block to replace. (3) Call replace_lines with new_content.
CRITICAL: Line numbers shift after every edit — always call read_file again before a subsequent replace_lines on the same file.
Use new_content = "" to delete the line range without inserting anything.
NEVER skip read_file — guessing line numbers without reading first is PROHIBITED.
TO INSERT NEW LINES WITHOUT DELETING: Set start_line and end_line to the exact same number (the line you want to target). In new_content, write the original text of that line, add a newline character (\\n), and then write your new code.`,
    parameters: {
      type: 'object',
      properties: {
        path:        { type: 'string', description: 'File path relative to workspace root.' },
        start_line:  { type: 'number', description: '1-based line number where the replacement begins (inclusive). Must come from a preceding read_file call.' },
        end_line:    { type: 'number', description: '1-based line number where the replacement ends (inclusive). Must be >= start_line.' },
        new_content: { type: 'string', description: 'Text to insert in place of the removed lines. Pass an empty string "" to delete the range. Do NOT add a trailing newline — the engine handles line endings.' },
        healing_mode: { type: 'boolean', description: 'Set to true ONLY if you are fixing a syntax error, unbalanced brace, or AST corruption. This temporarily disables the syntax and AST guards to allow surgical fixes on already broken files.' },
      },
      required: ['path', 'start_line', 'end_line', 'new_content'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const fp = safePath(workspacePath, args.path);
  if (!fs.existsSync(fp)) {
    return { success: false, output: `File not found: ${args.path}. Use list_dir to verify the path.` };
  }

  const startLine = Number(args.start_line);
  const endLine   = Number(args.end_line);

  if (!Number.isInteger(startLine) || startLine < 1) {
    return { success: false, output: `CRITICAL ERROR: start_line must be a positive integer >= 1 (received: ${args.start_line}). Call read_file first to get correct line numbers.` };
  }
  if (!Number.isInteger(endLine) || endLine < startLine) {
    return { success: false, output: `CRITICAL ERROR: end_line (${endLine}) must be an integer >= start_line (${startLine}). Call read_file to verify current line numbers.` };
  }
  if (typeof args.new_content !== 'string') {
    return { success: false, output: 'CRITICAL ERROR: new_content must be a string. Use an empty string "" to delete lines without inserting anything.' };
  }

  const original   = fs.readFileSync(fp, 'utf-8');

  // Black Box auto-backup — save original before any modification
  try {
    const backupDir  = path.join(workspacePath, '.fluxo', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp  = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `${path.basename(fp)}_${timestamp}.bak`;
    fs.writeFileSync(path.join(backupDir, backupName), original, 'utf-8');
  } catch {
    // Backup failure is non-fatal — edit proceeds regardless
  }

  const lines      = original.split('\n');
  const totalLines = lines.length;

  if (startLine > totalLines) {
    return { success: false, output: `CRITICAL ERROR: start_line (${startLine}) exceeds file length (${totalLines} lines). Call read_file to get updated line numbers.` };
  }

  const clampedEnd  = Math.min(endLine, totalLines);
  const clampNote   = endLine > totalLines ? ` (end_line ${endLine} clamped to file length ${totalLines})` : '';

  // Split new_content into lines. Strip trailing \n to avoid phantom blank line.
  const newLines = args.new_content === '' ? [] : args.new_content.replace(/\n$/, '').split('\n');

  const resultLines = [
    ...lines.slice(0, startLine - 1),
    ...newLines,
    ...lines.slice(clampedEnd),
  ];

  const updated = resultLines.join('\n');

  if (updated.trim() === '' && original.trim() !== '') {
    return { success: false, output: 'SAFETY ABORT: replacement would produce an empty file. Verify your line range and new_content.' };
  }

  const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
  const fileExt = path.extname(fp).toLowerCase();

  if (!args.healing_mode) {
    // Deterministic brace-balance guard — runs before writing to disk
    if (JS_EXTENSIONS.includes(fileExt)) {
      const openCount  = (updated.match(/\{/g) || []).length;
      const closeCount = (updated.match(/\}/g) || []).length;
      if (openCount !== closeCount) {
        return {
          success: false,
          output: `CRITICAL SYNTAX ERROR: Tu 'new_content' tiene llaves desequilibradas (${openCount} "{" vs ${closeCount} "}"). El archivo NO fue modificado.\nANTI-PANIC DIRECTIVE: ESTÁ ESTRICTAMENTE PROHIBIDO enviar el mismo código de nuevo. Tu bloque es demasiado grande.\nNUEVA ESTRATEGIA OBLIGATORIA: Divide la inserción. Primero inserta solo el esqueleto vacío del componente o función. En la SIGUIENTE iteración, rellena el contenido. No intentes inyectar más de 20 líneas de lógica de una sola vez.\nSi estás intentando arreglar un archivo YA corrupto, usa "healing_mode: true" para desactivar los guards.`,
        };
      }
    }

    // JSX/AST integrity guard — prevents orphaned or crossed tags in React files
    const JSX_EXTENSIONS_AST = ['.tsx', '.jsx'];
    if (JSX_EXTENSIONS_AST.includes(fileExt)) {
      const jsxBalance = (code: string): number => {
        const opens     = (code.match(/<[A-Za-z]/g) || []).length;
        const closes    = (code.match(/<\/[A-Za-z]/g) || []).length;
        const selfClose = (code.match(/\/>/g) || []).length;
        return opens - closes - selfClose;
      };
      const origBalance    = jsxBalance(original);
      const updatedBalance = jsxBalance(updated);
      if (origBalance !== updatedBalance) {
        return {
          success: false,
          output: `CRITICAL SYNTAX ERROR: AST/JSX Corruption detected. Etiquetas HTML/JSX desbalanceadas. El archivo NO fue modificado. ESTRATEGIA: Selecciona el bloque JSX completo desde su apertura hasta su cierre.\nSi estás intentando arreglar un archivo YA corrupto, usa "healing_mode: true" para desactivar los guards.`,
        };
      }
    }
  }

  const removedLines = lines.slice(startLine - 1, clampedEnd);
  const linesRemoved = clampedEnd - startLine + 1;
  const linesAdded   = newLines.length;

  // Anti-Mass-Deletion guard — blocks accidental truncation before the file is written
  if (linesRemoved > 50 && linesAdded < linesRemoved * 0.2) {
    return {
      success: false,
      output: `CRITICAL WARNING: ANTI-MASS-DELETION GUARD. Estás intentando eliminar ${linesRemoved} líneas pero solo insertando ${linesAdded}. ` +
              `Esto suele ser un error de truncamiento del modelo. Si realmente deseas hacer este borrado masivo, ` +
              `el motor requiere que lo dividas en bloques más pequeños o confirmes la acción. ` +
              `(Nota: la herramienta falla, no escribe el archivo, y obliga al agente a reconsiderar).`,
    };
  }

  fs.writeFileSync(fp, updated, 'utf-8');

  // Build a compact preview of removed content for auto-verification
  const removedText  = removedLines.join('\n');
  const removedPreview = removedText.length > 300
    ? removedText.slice(0, 300) + '\n…(truncated)'
    : removedText;

  return {
    success: true,
    output: `replace_lines: ${args.path} — replaced lines ${startLine}–${clampedEnd} (${linesRemoved} line${linesRemoved !== 1 ? 's' : ''} → ${linesAdded} line${linesAdded !== 1 ? 's' : ''})${clampNote}.\n\nLINES REMOVED:\n${removedPreview}\n\nEDICIÓN EXITOSA — Verifica que las líneas eliminadas son las correctas. Si la tarea no está completa, llama la SIGUIENTE herramienta ahora.`,
  };
}
