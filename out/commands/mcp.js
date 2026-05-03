#!/usr/bin/env node
"use strict";
// ─── Fluxo MCP CLI (v8.20.0) ────────────────────────────────────────────────
// Standalone Node entrypoint that mirrors `claude mcp add <server>`. Compiled
// to out/commands/mcp.js by tsc. Invoke from any workspace root with:
//
//   node <path-to-vsix>/out/commands/mcp.js add <alias>
//   node <path-to-vsix>/out/commands/mcp.js list
//   node <path-to-vsix>/out/commands/mcp.js remove <alias>
//   node <path-to-vsix>/out/commands/mcp.js registry
//
// Workspace is auto-detected from process.cwd() (or --workspace=<path>).
// All ops touch .fluxo/mcp_servers.json via mcpConfigWriter — same code path
// the in-extension `Fluxo: Add MCP Server` command uses.
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
exports.runCli = runCli;
const path = __importStar(require("path"));
const mcpRegistry_1 = require("../utils/mcpRegistry");
const mcpConfigWriter_1 = require("../utils/mcpConfigWriter");
function resolveWorkspace(args) {
    const flag = args.find(a => a.startsWith('--workspace='));
    if (flag) {
        return path.resolve(flag.substring('--workspace='.length));
    }
    return process.cwd();
}
function printUsage() {
    console.log('Fluxo MCP CLI (v8.20.0)');
    console.log('');
    console.log('Usage:');
    console.log('  fluxo mcp add <alias> [--workspace=<path>]');
    console.log('  fluxo mcp remove <alias> [--workspace=<path>]');
    console.log('  fluxo mcp list [--workspace=<path>]');
    console.log('  fluxo mcp registry');
    console.log('');
    console.log('Aliases live in the official registry (see `registry`).');
    console.log('Files written to <workspace>/.fluxo/mcp_servers.json.');
}
function cmdRegistry() {
    const entries = (0, mcpRegistry_1.listRegistry)();
    console.log(`Official MCP registry (${entries.length} entries):\n`);
    for (const e of entries) {
        const star = e.starter ? ' ★' : '';
        const cats = e.categories.join(', ');
        console.log(`  ${e.alias}${star}`);
        console.log(`    ${e.description}`);
        console.log(`    categories: ${cats}`);
        if (e.note) {
            console.log(`    note: ${e.note}`);
        }
        console.log('');
    }
    console.log('★ = included in the auto-generated starter pack.');
    return 0;
}
function cmdAdd(workspacePath, alias) {
    if (!alias) {
        console.error('error: missing <alias>. Try `fluxo mcp registry` to see available servers.');
        return 1;
    }
    const entry = (0, mcpRegistry_1.getRegistryEntry)(alias);
    if (!entry) {
        console.error(`error: "${alias}" is not in the official registry. Run \`fluxo mcp registry\` for the full list.`);
        return 1;
    }
    const result = (0, mcpConfigWriter_1.addServer)(workspacePath, alias);
    if (!result.ok) {
        console.error(`error: ${result.reason}`);
        return 1;
    }
    if (result.reason) {
        console.log(result.reason);
    }
    else {
        console.log(`✅ Added "${result.alias}" to ${workspacePath}/.fluxo/mcp_servers.json`);
        if (entry.note) {
            console.log(`   note: ${entry.note}`);
        }
    }
    return 0;
}
function cmdRemove(workspacePath, alias) {
    if (!alias) {
        console.error('error: missing <alias>.');
        return 1;
    }
    const result = (0, mcpConfigWriter_1.removeServer)(workspacePath, alias);
    if (!result.ok) {
        console.error(`error: ${result.reason}`);
        return 1;
    }
    console.log(result.reason ?? `✅ Removed "${alias}" from .fluxo/mcp_servers.json`);
    return 0;
}
function cmdList(workspacePath) {
    const configured = (0, mcpConfigWriter_1.listConfigured)(workspacePath);
    const aliases = Object.keys(configured).sort();
    if (aliases.length === 0) {
        console.log('No MCP servers configured. Run `fluxo mcp add <alias>` to add one.');
        return 0;
    }
    console.log(`Configured MCP servers (${aliases.length}):\n`);
    for (const alias of aliases) {
        const cfg = configured[alias];
        console.log(`  ${alias}`);
        console.log(`    command: ${cfg.command} ${(cfg.args ?? []).join(' ')}`);
        if (cfg.categories) {
            console.log(`    categories: ${cfg.categories.join(', ')}`);
        }
    }
    return 0;
}
function runCli(argv) {
    const args = argv.slice(2);
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        printUsage();
        return 0;
    }
    const sub = args[0];
    const wsPath = resolveWorkspace(args);
    const positional = args.slice(1).filter(a => !a.startsWith('--'));
    switch (sub) {
        case 'add': return cmdAdd(wsPath, positional[0]);
        case 'remove':
        case 'rm': return cmdRemove(wsPath, positional[0]);
        case 'list':
        case 'ls': return cmdList(wsPath);
        case 'registry': return cmdRegistry();
        default:
            console.error(`error: unknown subcommand "${sub}"`);
            printUsage();
            return 1;
    }
}
// Only execute when invoked directly (not when imported by extension.ts).
if (require.main === module) {
    process.exit(runCli(process.argv));
}
//# sourceMappingURL=mcp.js.map