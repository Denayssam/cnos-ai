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
const MEMORY_PATH = '.fluxo/memory.md';
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'update_memory',
        description: 'Create or overwrite the workspace memory file (.fluxo/memory.md). ' +
            'Use this tool when the user explicitly asks you to "remember" a rule, preference, or convention, ' +
            'OR when you and the user agree on an important architectural decision that should persist across sessions. ' +
            'Always include the full desired memory content — this overwrites the file completely. ' +
            'Read the existing memory first (if any) so you can merge old rules with new ones before writing.',
        parameters: {
            type: 'object',
            properties: {
                content: {
                    type: 'string',
                    description: 'Full markdown content for .fluxo/memory.md. Use headings (##) to organize rules by category. ' +
                        'Example sections: ## Coding Conventions, ## Architecture Decisions, ## User Preferences.',
                },
            },
            required: ['content'],
        },
    },
};
function execute(args, workspacePath) {
    if (typeof args.content !== 'string' || args.content.trim() === '') {
        return { success: false, output: 'CRITICAL ERROR: "content" is missing or empty.' };
    }
    const memoryFilePath = path.join(workspacePath, MEMORY_PATH);
    fs.mkdirSync(path.dirname(memoryFilePath), { recursive: true });
    fs.writeFileSync(memoryFilePath, args.content, 'utf-8');
    const size = Buffer.byteLength(args.content, 'utf-8');
    return {
        success: true,
        output: `Workspace memory updated: ${MEMORY_PATH} (${size} bytes). Rules will be injected into all agents on the next session.`,
    };
}
//# sourceMappingURL=index.js.map