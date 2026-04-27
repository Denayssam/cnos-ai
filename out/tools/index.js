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
exports.TOOL_DEFINITIONS = void 0;
exports.executeTool = executeTool;
exports.getNativeTools = getNativeTools;
const FileReadTool = __importStar(require("./FileReadTool"));
const FileWriteTool = __importStar(require("./FileWriteTool"));
const ReplaceLinesTool = __importStar(require("./ReplaceLinesTool"));
const ReplaceBlockTool = __importStar(require("./ReplaceBlockTool"));
const CreateDirTool = __importStar(require("./CreateDirTool"));
const ListDirTool = __importStar(require("./ListDirTool"));
const RunCommandTool = __importStar(require("./RunCommandTool"));
const DeleteFileTool = __importStar(require("./DeleteFileTool"));
const DeleteDirTool = __importStar(require("./DeleteDirTool"));
const ProposePlanTool = __importStar(require("./ProposePlanTool"));
const SearchInFilesTool = __importStar(require("./SearchInFilesTool"));
const SearchImagesTool = __importStar(require("./SearchImagesTool"));
const AskApprovalTool = __importStar(require("./AskApprovalTool"));
const SearchReplaceTool = __importStar(require("./SearchReplaceTool"));
const UpdateMemoryTool = __importStar(require("./UpdateMemoryTool"));
// ─── Tool Registry ────────────────────────────────────────────────────────────
const ALL_TOOLS = [
    FileReadTool,
    FileWriteTool,
    SearchReplaceTool,
    ReplaceLinesTool,
    ReplaceBlockTool,
    CreateDirTool,
    ListDirTool,
    RunCommandTool,
    DeleteFileTool,
    DeleteDirTool,
    ProposePlanTool,
    SearchInFilesTool,
    SearchImagesTool,
    AskApprovalTool,
    UpdateMemoryTool,
];
exports.TOOL_DEFINITIONS = ALL_TOOLS.map(t => t.TOOL_DEF);
const TOOL_MAP = Object.fromEntries(ALL_TOOLS.map(t => [t.TOOL_DEF.function.name, t.execute]));
function executeTool(name, args, workspacePath) {
    const fn = TOOL_MAP[name];
    if (!fn) {
        return { success: false, output: `[SYSTEM ENGINE ERROR]: Unknown tool: ${name}` };
    }
    try {
        return fn(args, workspacePath);
    }
    catch (err) {
        return { success: false, output: `[SYSTEM ENGINE ERROR]: ${err.message ?? String(err)}` };
    }
}
function getNativeTools(toolNames) {
    return exports.TOOL_DEFINITIONS.filter(t => toolNames.includes(t.function.name));
}
//# sourceMappingURL=index.js.map