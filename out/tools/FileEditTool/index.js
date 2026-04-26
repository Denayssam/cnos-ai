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
        name: 'edit_file',
        description: 'Surgically find and replace a specific string in a file. CRITICAL RULE: You MUST provide BOTH old_string AND new_string. NEVER omit old_string. If inserting new code, old_string must be the exact existing text (e.g., an import statement) that you will use as an anchor to replace with the anchor + the new code. PREFER MICRO-EDITS: If the change is complex, do multiple small edit_file calls instead of one large block to avoid syntax errors. WORKFLOW: (1) read_file to see exact text. (2) Copy the exact old_string from the output. (3) Provide new_string. Never use write_file on existing files.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace root.' },
                old_string: { type: 'string', description: 'REQUIRED — plain string only. The exact text to find. Must match the file exactly — copy from read_file output. NEVER omit. NEVER pass an object.' },
                new_string: { type: 'string', description: 'REQUIRED — plain string only. The replacement text. Use empty string to delete the matched block. NEVER omit. NEVER pass an object.' },
            },
            required: ['path', 'old_string', 'new_string'],
        },
    },
};
function execute(args, workspacePath) {
    const fp = (0, shared_1.safePath)(workspacePath, args.path);
    if (!fs.existsSync(fp)) {
        return { success: false, output: `File not found: ${args.path}. Use list_dir to verify the path.` };
    }
    // Alias resolution — accept old_value/new_value but correct the model
    const aliasWarnings = [];
    const rawOld = args.old_string ?? args.old_value;
    const rawNew = args.new_string ?? args.new_value;
    if (args.old_string === undefined && typeof args.old_value === 'string') {
        aliasWarnings.push(`⚠ ALIAS USADO: Enviaste 'old_value' en lugar de 'old_string'. Por favor usa siempre 'old_string' en el futuro para mayor precisión.`);
    }
    if (args.new_string === undefined && typeof args.new_value === 'string') {
        aliasWarnings.push(`⚠ ALIAS USADO: Enviaste 'new_value' en lugar de 'new_string'. Por favor usa siempre 'new_string' en el futuro para mayor precisión.`);
    }
    if (typeof rawOld !== 'string' || !rawOld) {
        return { success: false, output: 'CRITICAL ERROR: "old_string" is required and must be a plain string. Call read_file first to get the exact text to replace. NEVER pass an object or omit this field.' };
    }
    if (typeof rawNew !== 'string') {
        return { success: false, output: 'CRITICAL ERROR: "new_string" is required and must be a plain string. Pass an empty string "" to delete, or the replacement text. NEVER pass an object or omit this field.' };
    }
    const oldString = rawOld;
    const newString = rawNew;
    const original = fs.readFileSync(fp, 'utf-8');
    if (!original.includes(oldString)) {
        const preview = oldString.slice(0, 120).replace(/\r?\n/g, '↵');
        return {
            success: false,
            output: [
                `FIND FAILED — old_string not found in ${args.path}.`,
                `Searched for: "${preview}"`,
                `Call read_file first to get the exact text. Do NOT guess whitespace or indentation.`,
            ].join('\n'),
        };
    }
    const updated = original.replace(oldString, newString);
    if (updated.trim() === '') {
        return { success: false, output: 'SAFETY ABORT: replacement would produce an empty file. Check your old_string.' };
    }
    fs.writeFileSync(fp, updated, 'utf-8');
    const preview = oldString.slice(0, 60).replace(/\r?\n/g, '↵');
    const correctionNote = aliasWarnings.length > 0 ? '\n\n' + aliasWarnings.join('\n') : '';
    return {
        success: true,
        output: `edit_file: ${args.path} — replaced "${preview}..."\n\nEDICION EXITOSA — Si la tarea no esta completa, llama la SIGUIENTE herramienta ahora.${correctionNote}`,
    };
}
//# sourceMappingURL=index.js.map