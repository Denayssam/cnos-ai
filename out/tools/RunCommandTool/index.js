"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_DEF = void 0;
exports.execute = execute;
const child_process_1 = require("child_process");
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'run_command',
        description: 'Execute a shell command in the workspace. On Windows, always quote paths containing spaces.',
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
    const BLOCKED = [/rm\s+-rf\s+[/\\~]/, /format\s+[a-z]:/, /del\s+\/[fs]/i, /mkfs/, /dd\s+if=/];
    if (BLOCKED.some(b => b.test(cmd))) {
        return { success: false, output: `Blocked dangerous command: ${cmd}` };
    }
    // Block persistent dev-server processes — they hang spawnSync and cause ETIMEDOUT loops.
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
            output: `CRITICAL: Persistent servers like "npm run dev" hang the swarm. DIRECTIVE: Do not panic. Immediately use "npm run build" instead to verify your changes and continue the workflow.`,
        };
    }
    const output = (0, child_process_1.execSync)(cmd, {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout,
        maxBuffer: 1024 * 1024 * 4,
    });
    return { success: true, output: output || '(command completed with no output)' };
}
//# sourceMappingURL=index.js.map