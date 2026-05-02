"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_DEF = void 0;
exports.execute = execute;
const child_process_1 = require("child_process");
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'run_command',
        description: 'Execute a shell command in the workspace directory. ' +
            'CRITICAL: DO NOT use this tool to read files (e.g., cat, type, Get-Content). You MUST use read_file instead. Bypassing this will result in instant failure. ' +
            'On Windows use Windows commands (dir, del, move, copy) — never Linux commands (ls, rm -rf, mv, cp). ' +
            'Always quote paths that contain spaces. ' +
            'WORKTREE NOTE: If a Git Worktree is active, do NOT use "cd" to navigate into it. ' +
            'All native tools (read_file, run_command, replace_block) already operate on the correct ' +
            'workspace context automatically — attempting "cd <worktree-path>" will break the working directory. ' +
            'WINDOWS ENOENT RULE (v8.16.8): If npm run build (or any command) fails with ENOENT related to cmd.exe ' +
            'or spawnSync, do NOT try to use PowerShell, node -e, or any hacking script as a workaround. ' +
            'It is a Node environment error — the OS shell is unreachable. Yield to human and stop the task. ' +
            'MICRO-ROLLBACK ALLOWED (v8.16.13): "git restore <path>" is explicitly permitted and is your CTRL+Z ' +
            'when an edit catastrophically breaks a single file. Use it before attempting any further fixes.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The shell command to execute.' },
            },
            required: ['command'],
        },
    },
};
function execute(args, workspacePath) {
    const cmd = args.command;
    const timeout = args.timeout || 30000;
    // ── Explicit Allowlist: Micro-Rollback (v8.16.13) ────────────────────────────
    // `git restore <path>` is the agent's CTRL+Z when an edit catastrophically
    // breaks a single file. It must NEVER be intercepted by any blocker downstream
    // (Vite panic, evasion shield, persistent server, etc.) since the patterns
    // below could otherwise false-positive on filenames or flags. We short-circuit
    // here and route directly to execution.
    const GIT_RESTORE_ALLOW = /^\s*git\s+restore\s+\S+/i;
    if (GIT_RESTORE_ALLOW.test(cmd)) {
        const isWindowsRestore = process.platform === 'win32';
        const restoreShell = isWindowsRestore
            ? (process.env.ComSpec || process.env.COMSPEC || 'cmd.exe')
            : undefined;
        try {
            const output = (0, child_process_1.execSync)(cmd, {
                cwd: workspacePath,
                encoding: 'utf-8',
                timeout,
                maxBuffer: 1024 * 1024 * 4,
                shell: restoreShell,
                env: { ...process.env },
            });
            return { success: true, output: output || '(git restore completed — file reverted to last committed state)' };
        }
        catch (err) {
            const stderr = err?.stderr ? String(err.stderr).trim() : '';
            const stdout = err?.stdout ? String(err.stdout).trim() : '';
            return { success: false, output: [stdout, stderr].filter(Boolean).join('\n') || String(err?.message ?? err) };
        }
    }
    // ── Raw Git Branching/Merging Block (v8.17.4) ────────────────────────────────
    // The v8.17.1 RAW_GIT_WORKFLOW_BLOCK was a prompt-level rule. Under merge
    // conflict pressure the LLM ignored it and panicked with raw `git checkout`
    // / `git merge`, fighting the worktree engine and corrupting MERGING state.
    // Promote to a tool-level physical block: any segment of the command (split
    // on |, ;, &) that starts with `git checkout` or `git merge` fails fast.
    // `git restore` is already short-circuited above so file-level rollback is
    // unaffected. `git merge --abort` is allowed because it is a recovery path,
    // not a branching/merging operation.
    const RAW_GIT_BLOCK_PATTERN = /^\s*git\s+(checkout|merge)\b/i;
    const MERGE_ABORT_ALLOW = /^\s*git\s+merge\s+--abort\b/i;
    const _gitSegments = cmd.split(/\s*[|;&]+\s*/);
    if (_gitSegments.some(seg => RAW_GIT_BLOCK_PATTERN.test(seg) && !MERGE_ABORT_ALLOW.test(seg))) {
        return {
            success: false,
            output: '[SYSTEM BLOCK] Raw git branching/merging is physically disabled. Use exit_worktree.',
        };
    }
    // ─────────────────────────────────────────────────────────────────────────────
    // ── Vite Panic Blocker (v8.16.12) ────────────────────────────────────────────
    // When npm run build fails, the LLM tends to panic and try to delete dist/,
    // .vite cache, node_modules/.cache, or pass --force to bypass "stale cache".
    // None of these fix syntax errors — the bug is in the code, not the cache.
    // Intercept these commands BEFORE anything else and force the agent back to
    // reading the compiler error and fixing the actual file.
    const VITE_PANIC_PATTERNS = [
        /--force\b/i,
        /\bdel\s+(?:\/[a-z]\s+)*["']?dist["']?\b/i,
        /\brmdir\b/i,
        /\bcopy\s+\/b\b/i,
        /\brm\s+-rf?\s+["']?(?:\.\/)?(?:dist|\.vite|\.cache|node_modules[\\\/]\.cache)/i,
        /\bRemove-Item\b.*\b(?:dist|\.vite|\.cache|node_modules)/i,
    ];
    if (VITE_PANIC_PATTERNS.some(p => p.test(cmd))) {
        return {
            success: false,
            output: "[SYSTEM ERROR] Comando denegado. Vite NO está cacheando tu error. " +
                "El error de sintaxis sigue en el código. No intentes borrar 'dist' ni usar '--force'. " +
                "Encuentra el error real en el archivo, arréglalo y vuelve a ejecutar 'npm run build'.",
        };
    }
    // ── Destructive command block ────────────────────────────────────────────────
    const BLOCKED = [/rm\s+-rf\s+[/\\~]/, /format\s+[a-z]:/, /del\s+\/[fs]/i, /mkfs/, /dd\s+if=/];
    if (BLOCKED.some(b => b.test(cmd))) {
        return { success: false, output: `Blocked dangerous command: ${cmd}` };
    }
    // ── Anti-Hacker Shield: block CLI direct file-reading ───────────────────────
    // Only the FIRST segment (before any pipe) is checked — this allows legitimate
    // pipeline filtering like "npm run build | head -50" or "tsc 2>&1 | grep error".
    // The filter in those cases processes STDIN (stdout from the prior command),
    // not a file on disk. Direct usage as first command IS blocked.
    //
    // BLOCKED: grep "error" src/file.ts  |  head -100 src/file.ts  |  cat file.js
    // ALLOWED: npm run build | grep error |  tsc | head -50         |  git log | tail -20
    const CLI_FILE_READ = /^\s*(cat|tail|head|less|more|type|Get-Content|findstr|grep|wc)\b/i;
    const cmdSegments = cmd.split(/\s*[|;&]+\s*/);
    const firstSegment = cmdSegments[0] ?? '';
    if (CLI_FILE_READ.test(firstSegment)) {
        return {
            success: false,
            output: 'SYSTEM ERROR: Intento de lectura de archivo por terminal bloqueado. ' +
                'NO uses comandos de consola (cat, type, grep, head, etc.) para leer código directamente. ' +
                'Usa read_file o search_in_files. ' +
                'Para filtrar OUTPUT de otro comando, usa el pipe: "npm run build | grep error" es VÁLIDO.',
        };
    }
    // ── Evasion Block: prevent sed, awk, node -e, perl, python -c ───────────────
    const EVASION_TOOLS = /^\s*(sed|awk|node\s+-e|perl|python\s+-c)\b/i;
    if (cmdSegments.some(seg => EVASION_TOOLS.test(seg))) {
        return {
            success: false,
            output: 'SYSTEM SECURITY ALERT: Intento de evasión detectado. Tienes PROHIBIDO usar ' +
                'herramientas de CLI (sed, awk, node -e, etc.) para manipular código. ' +
                'Usa read_file y replace_block o replace_symbol inmediatamente.',
        };
    }
    // ── Persistent dev-server block ──────────────────────────────────────────────
    const PERSISTENT_PATTERNS = [
        /\bnpm\s+run\s+dev\b/,
        /\bnpm\s+start\b/,
        /\bnpm\s+run\s+start\b/,
        /\byarn\s+dev\b/,
        /\byarn\s+start\b/,
        /\bpnpm\s+dev\b/,
        /\bpnpm\s+start\b/,
        /\bnodemon\b/,
        /\bnext\s+dev\b/,
        /\bvite\b(?!\s+build)/,
        /\bwebpack\s+--watch\b/,
        /\bng\s+serve\b/,
    ];
    if (PERSISTENT_PATTERNS.some(p => p.test(cmd))) {
        return {
            success: false,
            output: 'CRITICAL: Persistent servers like "npm run dev" hang the swarm. ' +
                'DIRECTIVE: Do not panic. Use "npm run build" instead to verify your changes and continue.',
        };
    }
    // ── Execute ──────────────────────────────────────────────────────────────────
    // v8.16.8 — Windows Shell Patch: pass `shell` explicitly so Node never resolves
    // an empty/missing ComSpec. On Windows we prefer `%ComSpec%` (usually
    // C:\WINDOWS\system32\cmd.exe), fall back to literal "cmd.exe", and merge in
    // `process.env` so System32 stays on PATH. On POSIX we just pass `shell: true`.
    const isWindows = process.platform === 'win32';
    const shellPath = isWindows
        ? (process.env.ComSpec || process.env.COMSPEC || 'cmd.exe')
        : undefined; // POSIX: let execSync default to /bin/sh
    try {
        const output = (0, child_process_1.execSync)(cmd, {
            cwd: workspacePath,
            encoding: 'utf-8',
            timeout,
            maxBuffer: 1024 * 1024 * 4,
            shell: shellPath,
            env: { ...process.env },
        });
        return { success: true, output: output || '(command completed with no output)' };
    }
    catch (err) {
        // ── ENOENT cmd.exe detection (v8.16.8) ─────────────────────────────────────
        // Surface a clear "yield to human" message instead of letting the LLM panic
        // and try to evade with PowerShell or sed/awk hacks.
        const errMsg = String(err?.message ?? err ?? '');
        const errCode = err?.code ?? '';
        const isShellMissing = errCode === 'ENOENT' &&
            (/cmd\.exe/i.test(errMsg) || /spawnSync/i.test(errMsg) || /system32/i.test(errMsg));
        if (isShellMissing) {
            return {
                success: false,
                output: '[YIELD TO HUMAN — Node Environment Error] spawnSync could not locate cmd.exe ' +
                    '(ENOENT). This is NOT a code problem and NOT a tool problem — Node lost its ' +
                    'reference to the system shell, usually because the ComSpec environment variable ' +
                    'is empty or System32 is missing from PATH in this VS Code session. ' +
                    'DO NOT retry this command. DO NOT switch to PowerShell, node -e, or any other ' +
                    'evasion script. Stop the task and ask the user to: (1) restart VS Code from a ' +
                    'fresh terminal so the environment is reloaded, or (2) verify that ' +
                    '%ComSpec% points to C:\\Windows\\System32\\cmd.exe and that System32 is on PATH.',
            };
        }
        // execSync throws on non-zero exit — capture both stdout and stderr from the error object
        const stdout = err.stdout ? String(err.stdout).trim() : '';
        const stderr = err.stderr ? String(err.stderr).trim() : '';
        const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
        return { success: false, output: combined || errMsg || 'Command failed with no output' };
    }
}
//# sourceMappingURL=index.js.map