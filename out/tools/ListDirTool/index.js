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
        name: 'list_dir',
        description: 'List files and folders in a directory.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory to list. Use "." for workspace root.' },
            },
            required: ['path'],
        },
    },
};
function execute(args, workspacePath) {
    const dp = (0, shared_1.safePath)(workspacePath, args.path || '.');
    if (!fs.existsSync(dp)) {
        return { success: false, output: `Directory not found: ${args.path}` };
    }
    const entries = fs.readdirSync(dp, { withFileTypes: true });
    const lines = entries.map(e => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`);
    return { success: true, output: lines.join('\n') || '(empty)' };
}
//# sourceMappingURL=index.js.map