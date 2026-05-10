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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const shared_1 = require("../shared");
const MEMORY_RELATIVE = '.fluxo/memory.md';
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'update_memory',
        description: 'Append a Blameless Post-Mortem entry to .fluxo/memory.md. ' +
            'Use this tool ONLY after a failure or non-trivial recovery (Circuit Breaker, repeated build failures, ' +
            'tool misuse, corrupted imports, missed pre-step like get_repo_map, etc.). ' +
            'Do NOT use it to log generic success messages — the memory is a high-signal post-mortem log. ' +
            'You MUST explicitly document what_failed, why_it_failed, and the_fix. ' +
            'TIMING: Only call after npm run build is green — log the verified post-fix truth, never a hypothesis.',
        parameters: {
            type: 'object',
            properties: {
                task_id: {
                    type: 'string',
                    description: 'Short identifier or description of the task context. ' +
                        'Examples: "auth-refactor", "stripe-webhook-fix", "circuit-breaker-recovery".',
                },
                outcome: {
                    type: 'string',
                    enum: ['Success', 'Failure'],
                    description: 'Whether the task ultimately succeeded after recovery (Success) or had to be abandoned (Failure). ' +
                        'A Success outcome is still allowed if the journey involved a failure that you recovered from — ' +
                        'document the failure path in the other fields.',
                },
                what_failed: {
                    type: 'string',
                    description: 'Concrete description of the error or blockage. Examples: "Corrupted imports during search_and_replace", ' +
                        '"Forgot to call get_repo_map before delegating to coder", "search_and_replace returned MATCH ERROR ' +
                        '3 times in a row on the same file", "Circuit Breaker fired after 3 consecutive failed builds".',
                },
                why_it_failed: {
                    type: 'string',
                    description: 'Root cause analysis. Examples: "Tabs vs spaces drift in the source file caused fuzzy matcher to ' +
                        'reject the snippet", "Skipped repo map so I guessed the wrong file path", "The library requires ' +
                        'middleware registration BEFORE express.json() and the docs bury this fact".',
                },
                the_fix: {
                    type: 'string',
                    description: 'Concrete technical solution applied. Examples: "Read the file with read_file then copied the ' +
                        'snippet verbatim character by character", "Called get_repo_map first and confirmed the actual ' +
                        'symbol location", "Re-ordered middleware: rawBody parser before express.json()".',
                },
            },
            required: ['task_id', 'outcome', 'what_failed', 'why_it_failed', 'the_fix'],
        },
    },
};
function execute(args, workspacePath) {
    const { task_id, outcome, what_failed, why_it_failed, the_fix } = args;
    if (typeof task_id !== 'string' || task_id.trim() === '') {
        return { success: false, output: 'CRITICAL ERROR: "task_id" is required and must be a non-empty string.' };
    }
    if (outcome !== 'Success' && outcome !== 'Failure') {
        return { success: false, output: 'CRITICAL ERROR: "outcome" must be either "Success" or "Failure".' };
    }
    if (typeof what_failed !== 'string' || what_failed.trim() === '') {
        return { success: false, output: 'CRITICAL ERROR: "what_failed" is required. Describe the concrete error or blockage encountered.' };
    }
    if (typeof why_it_failed !== 'string' || why_it_failed.trim() === '') {
        return { success: false, output: 'CRITICAL ERROR: "why_it_failed" is required. Provide the root cause analysis.' };
    }
    if (typeof the_fix !== 'string' || the_fix.trim() === '') {
        return { success: false, output: 'CRITICAL ERROR: "the_fix" is required. Describe the concrete technical solution applied.' };
    }
    let memoryFilePath;
    try {
        memoryFilePath = (0, shared_1.safePath)(workspacePath, MEMORY_RELATIVE);
    }
    catch (e) {
        return { success: false, output: `[SYSTEM SHIELD] ${e.message}` };
    }
    fs.mkdirSync(path.dirname(memoryFilePath), { recursive: true });
    const now = new Date();
    const timestamp = now.toISOString().replace('T', ' ').substring(0, 19);
    const entry = `\n### [${timestamp}] - Task: ${task_id.trim()}\n` +
        `- **Outcome:** ${outcome}\n` +
        `- **What Failed:** ${what_failed.trim()}\n` +
        `- **Why it Failed:** ${why_it_failed.trim()}\n` +
        `- **The Fix:** ${the_fix.trim()}\n`;
    fs.appendFileSync(memoryFilePath, entry, 'utf-8');
    return {
        success: true,
        output: `Post-mortem entry appended to ${MEMORY_RELATIVE}. Timestamp: ${timestamp}. Outcome: ${outcome}.`,
    };
}
//# sourceMappingURL=index.js.map