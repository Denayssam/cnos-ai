#!/usr/bin/env node
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

import * as path from 'path';
import { listRegistry, getRegistryEntry } from '../utils/mcpRegistry';
import { addServer, removeServer, listConfigured } from '../utils/mcpConfigWriter';

function resolveWorkspace(args: string[]): string {
  const flag = args.find(a => a.startsWith('--workspace='));
  if (flag) { return path.resolve(flag.substring('--workspace='.length)); }
  return process.cwd();
}

function printUsage(): void {
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

function cmdRegistry(): number {
  const entries = listRegistry();
  console.log(`Official MCP registry (${entries.length} entries):\n`);
  for (const e of entries) {
    const star = e.starter ? ' ★' : '';
    const cats = e.categories.join(', ');
    console.log(`  ${e.alias}${star}`);
    console.log(`    ${e.description}`);
    console.log(`    categories: ${cats}`);
    if (e.note) { console.log(`    note: ${e.note}`); }
    console.log('');
  }
  console.log('★ = included in the auto-generated starter pack.');
  return 0;
}

function cmdAdd(workspacePath: string, alias: string | undefined): number {
  if (!alias) {
    console.error('error: missing <alias>. Try `fluxo mcp registry` to see available servers.');
    return 1;
  }
  const entry = getRegistryEntry(alias);
  if (!entry) {
    console.error(`error: "${alias}" is not in the official registry. Run \`fluxo mcp registry\` for the full list.`);
    return 1;
  }
  const result = addServer(workspacePath, alias);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }
  if (result.reason) {
    console.log(result.reason);
  } else {
    console.log(`✅ Added "${result.alias}" to ${workspacePath}/.fluxo/mcp_servers.json`);
    if (entry.note) { console.log(`   note: ${entry.note}`); }
  }
  return 0;
}

function cmdRemove(workspacePath: string, alias: string | undefined): number {
  if (!alias) {
    console.error('error: missing <alias>.');
    return 1;
  }
  const result = removeServer(workspacePath, alias);
  if (!result.ok) {
    console.error(`error: ${result.reason}`);
    return 1;
  }
  console.log(result.reason ?? `✅ Removed "${alias}" from .fluxo/mcp_servers.json`);
  return 0;
}

function cmdList(workspacePath: string): number {
  const configured = listConfigured(workspacePath);
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
    if (cfg.categories) { console.log(`    categories: ${cfg.categories.join(', ')}`); }
  }
  return 0;
}

export function runCli(argv: string[]): number {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    return 0;
  }
  const sub = args[0];
  const wsPath = resolveWorkspace(args);
  const positional = args.slice(1).filter(a => !a.startsWith('--'));

  switch (sub) {
    case 'add':      return cmdAdd(wsPath, positional[0]);
    case 'remove':
    case 'rm':       return cmdRemove(wsPath, positional[0]);
    case 'list':
    case 'ls':       return cmdList(wsPath);
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
