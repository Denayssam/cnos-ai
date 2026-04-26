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
const shared_1 = require("../shared");
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'read_file',
        description: 'Read the full contents of a file. Each line is prefixed with its 1-based line number. Use this before edit_file to see the exact text to replace.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path to the file relative to the workspace root.' },
            },
            required: ['path'],
        },
    },
};
function execute(args, workspacePath) {
    const fp = (0, shared_1.safePath)(workspacePath, args.path);
    if (!fs.existsSync(fp)) {
        const parentDir = (args.path || '.').split('/').slice(0, -1).join('/') || '.';
        return {
            success: false,
            output: [
                `FILE NOT FOUND: "${args.path}"`,
                ``,
                `MANDATORY NEXT STEP: Call list_dir BEFORE any further read_file attempts.`,
                `  Suggested target: list_dir on "${parentDir}"`,
                `DO NOT retry read_file on guessed paths. Discover the actual structure first.`,
            ].join('\n'),
        };
    }
    const buffer = fs.readFileSync(fp);
    let content;
    // Detect UTF-16LE (BOM: FF FE) or generic binary with null bytes
    if (buffer.length > 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
        content = buffer.toString('utf16le');
    }
    else if (buffer.indexOf(0) !== -1) {
        // Strip null bytes from other encodings to avoid API errors
        content = buffer.toString('utf-8').replace(/\0/g, '');
    }
    else {
        content = buffer.toString('utf-8');
    }
    const truncated = content.length > 60000
        ? content.slice(0, 60000) + '\n...[truncated at 60KB]'
        : content;
    const numbered = truncated.split('\n').map((line, i) => `${i + 1} | ${line}`).join('\n');
    return { success: true, output: numbered };
}
//# sourceMappingURL=index.js.map