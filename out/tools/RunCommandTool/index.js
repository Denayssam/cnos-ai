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
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// ─── Strengthened Windows Spawn (v8.24.0) ────────────────────────────────────
// Single source of truth for the `shell` option passed to every execSync call
// in this module. The original spec called for
// `shell: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : true`,
// but execSync's typed contract only accepts `string | undefined` (the boolean
// `true` form is documented for `spawn`/`spawnSync`, not `execSync`). To honor
// the spec's INTENT (force Windows to find the terminal explicitly so a missing
// %ComSpec% never silently spawns nothing), we resolve to a concrete shell
// path on Windows and fall back to `undefined` on POSIX — which Node documents
// as "execSync will use /bin/sh", the default we want there. The behavior is
// platform-deterministic and the v8.24.0 Financial Killswitch in the engine
// can rely on a clean one-shot [YIELD TO HUMAN] payload when the shell is
// genuinely unreachable.
function resolveShellOption() {
    return process.platform === 'win32'
        ? (process.env.ComSpec || process.env.COMSPEC || 'cmd.exe')
        : undefined;
}
// ─────────────────────────────────────────────────────────────────────────────
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'run_command',
        description: 'Execute a shell command (npm/tsc/git/firebase). NEVER for reading files (use read_file) ' +
            'or for ls/find/grep/cat (use glob/grep/list_dir/search_in_files). Worktree is auto-routed — ' +
            'do NOT use "cd .fluxo/worktrees/...". Quote paths with spaces. ' +
            '"git restore <path>" is your CTRL+Z when an edit breaks a file.',
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
    // ── Terminal Path Hallucination Guard (v8.21.0) ──────────────────────────────
    // The agent already executes inside a worktree dynamically — the engine routes
    // every native tool to the correct sandbox automatically. Yet under recovery
    // pressure the LLM hallucinates `cd .fluxo/worktrees/<id>` to "navigate" into
    // its own sandbox, which (a) breaks the working directory because the path is
    // nested twice, and (b) is the trigger that pushes turns into the 25-iteration
    // ceiling. Intercept BEFORE every other shield so the false-positive surface
    // of downstream regexes (vite panic, evasion, persistent server) cannot mask
    // this specific failure mode. Match both POSIX and Windows separators.
    const WORKTREE_CD_PATTERN = /\bcd\s+["']?\.fluxo[\\\/]worktrees[\\\/]/i;
    if (WORKTREE_CD_PATTERN.test(cmd)) {
        return {
            success: false,
            output: '[SYSTEM SHIELD] You are already executing inside the worktree dynamically. ' +
                "DO NOT use 'cd' to navigate to .fluxo paths. " +
                'Use relative paths from the root of your current sandbox.',
        };
    }
    // ── Explicit Allowlist: Micro-Rollback (v8.16.13) ────────────────────────────
    // `git restore <path>` is the agent's CTRL+Z when an edit catastrophically
    // breaks a single file. It must NEVER be intercepted by any blocker downstream
    // (Vite panic, evasion shield, persistent server, etc.) since the patterns
    // below could otherwise false-positive on filenames or flags. We short-circuit
    // here and route directly to execution.
    const GIT_RESTORE_ALLOW = /^\s*git\s+restore\s+\S+/i;
    if (GIT_RESTORE_ALLOW.test(cmd)) {
        try {
            const output = (0, child_process_1.execSync)(cmd, {
                cwd: workspacePath,
                encoding: 'utf-8',
                timeout,
                maxBuffer: 1024 * 1024 * 4,
                shell: resolveShellOption(),
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
    // ── File-Creation-via-Shell Shield (v8.36.7) ─────────────────────────────────
    // MUST run BEFORE the Anti-Hacker (read) shield below, because the CLI_FILE_READ
    // regex matches the bare verb `type` and would mislabel a CREATE intent
    // (`type nul > src\store.ts`) as a blocked "file read", suggesting read_file —
    // the wrong tool. Test 16 dogfooding: @coder tried `type nul > src\store.ts` to
    // scaffold an empty file, got "lectura bloqueada", never learned to use
    // write_file, and burned iterations. Here we catch the file-CREATION idioms
    // explicitly and route the agent to the correct tool (write_file). Conservative
    // by design: we target the known creation verbs, NOT every `>` redirection, so
    // legitimate command-output logging / `2>&1` is never false-positived.
    const FILE_CREATE_VIA_SHELL = [
        /\btype\s+nul\s*>>?/i, // type nul > file        (cmd)
        /\becho\b[^|]*>>?\s*["']?[\w.$/\\-]/i, // echo ... > file        (cmd/sh)
        /\bcopy\s+con\b/i, // copy con file          (cmd)
        /\bfsutil\s+file\s+createnew\b/i, // fsutil file createnew  (cmd)
        /\bNew-Item\b[^|]*-ItemType\s+File/i, // New-Item -ItemType File (PS)
        /(?:^|[|;&]\s*)ni\s+[^|]*-ItemType\s+File/i, // ni -ItemType File       (PS)
        /\b(?:Set-Content|Add-Content|Out-File)\b/i, // PowerShell write cmdlets
        /(?:^|[|;&]\s*)touch\s+\S/i, // touch file             (POSIX)
    ];
    if (FILE_CREATE_VIA_SHELL.some(p => p.test(cmd))) {
        return {
            success: false,
            output: '[SYSTEM SHIELD] Para CREAR o ESCRIBIR un archivo usa la herramienta write_file(path, content) — ' +
                'nunca redirección de shell (type nul >, echo >, copy con, New-Item, touch). ' +
                'write_file crea los directorios padre automáticamente y es idempotente, ' +
                'incluso para archivos vacíos. La terminal es EXCLUSIVA para npm/tsc/git.',
        };
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
    // v8.24.0 — Windows Spawn Strengthening: shell selection is centralized in
    // resolveShellOption() at the top of the module. Windows resolves to
    // %ComSpec% (typically C:\WINDOWS\system32\cmd.exe) with a `cmd.exe`
    // fallback for empty/detached env; POSIX gets explicit `shell: true` rather
    // than `undefined` so the execSync behavior is platform-deterministic. The
    // engine's Financial Killswitch (v8.24.0) depends on a clean one-shot
    // [YIELD TO HUMAN] payload when the OS shell genuinely cannot be reached —
    // making the spawn behavior implicit invited subtle differences across Node
    // versions and VS Code reload contexts.
    try {
        const output = (0, child_process_1.execSync)(cmd, {
            cwd: workspacePath,
            encoding: 'utf-8',
            timeout,
            maxBuffer: 1024 * 1024 * 4,
            shell: resolveShellOption(),
            env: { ...process.env },
        });
        return { success: true, output: output || '(command completed with no output)' };
    }
    catch (err) {
        // ── ENOENT cmd.exe detection (v8.16.8 → v8.24.0) ───────────────────────────
        // Surface a clear "yield to human" message instead of letting the LLM panic
        // and try to evade with PowerShell or sed/awk hacks. The engine's Financial
        // Killswitch breaks the loop on the [YIELD TO HUMAN sentinel before the
        // payload reaches the LLM, preventing API-credit drain on a problem that
        // lives outside the process. Detection broadened in v8.24.0 to also catch
        // the EPERM and EACCES variants seen on locked-down Windows hosts where
        // cmd.exe exists but is inaccessible to the spawned child.
        const errMsg = String(err?.message ?? err ?? '');
        const errCode = err?.code ?? '';
        const isShellMissing = (errCode === 'ENOENT' || errCode === 'EPERM' || errCode === 'EACCES') &&
            (/cmd\.exe/i.test(errMsg) || /spawnSync/i.test(errMsg) || /system32/i.test(errMsg) || /comspec/i.test(errMsg));
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
        // ── Missing-script Hint + Auto-Repair (v8.36.7) ────────────────────────────
        // Test 16 dogfooding: @coder ran `npm run build` against a package.json it had
        // just written WITHOUT a "scripts.build" entry, got `Missing script: "build"`,
        // then thrashed (`npx tsc --verbose` → TS5093) into MAX_ITERATIONS. Two layers:
        //   (1) Auto-repair — if package.json exists, lacks the script, and the value is
        //       SAFELY inferable (build→tsc, gated on tsconfig.json; start→node dist/index.js),
        //       add ONLY that one script and announce it (transparent, never silent;
        //       never overwrites; reversible via the engine's git checkpoint + worktree diff).
        //   (2) Hint — otherwise, append an actionable directive so the raw npm error
        //       becomes "read_file → add script with write_file → re-run", speaking the
        //       same language as the @coder SCAFFOLD PROTOCOL prompt (Cohesión Sistémica).
        const scriptRunMatch = cmd.match(/^\s*(?:npm|yarn|pnpm)\s+run\s+([\w:-]+)/i);
        if (scriptRunMatch && /missing script/i.test(combined)) {
            const scriptName = scriptRunMatch[1];
            const pkgPath = path.join(workspacePath, 'package.json');
            try {
                if (fs.existsSync(pkgPath)) {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                    pkg.scripts = pkg.scripts || {};
                    if (!pkg.scripts[scriptName]) {
                        const hasTsconfig = fs.existsSync(path.join(workspacePath, 'tsconfig.json'));
                        let inferred;
                        if (scriptName === 'build' && hasTsconfig)
                            inferred = 'tsc';
                        else if (scriptName === 'start')
                            inferred = 'node dist/index.js';
                        if (inferred) {
                            pkg.scripts[scriptName] = inferred;
                            fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
                            return {
                                success: false,
                                output: `[SYSTEM AUTO-REPAIR] package.json no tenía "scripts.${scriptName}". ` +
                                    `He añadido "${scriptName}": "${inferred}". Revisa el cambio y vuelve a ejecutar ` +
                                    `\`npm run ${scriptName}\`. (Cambio acotado y reversible: queda registrado en el ` +
                                    `checkpoint del Time Machine y en el diff del worktree antes de cualquier merge.)`,
                            };
                        }
                    }
                }
            }
            catch { /* fall through to the hint — auto-repair must never throw */ }
            return {
                success: false,
                output: combined + '\n\n' +
                    `[SYSTEM HINT] El script "${scriptName}" no existe en package.json. ` +
                    `NO reintentes el comando ni improvises npx con flags. ` +
                    `Usa read_file('package.json') → añade "${scriptName}" al bloque "scripts" con write_file → ` +
                    `re-ejecuta. Para un proyecto TypeScript, "build": "tsc".`,
            };
        }
        return { success: false, output: combined || errMsg || 'Command failed with no output' };
    }
}
//# sourceMappingURL=index.js.map