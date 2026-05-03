"use strict";
// ─── Official MCP Registry (v8.20.0 — Zero-Config UX) ───────────────────────
// Curated catalog of well-known open-source MCP servers. Each entry pairs a
// short alias (what the user types in `fluxo mcp add <name>`) with a
// runnable command, default args, and pre-baked categories that feed straight
// into the v8.19.0 RBAC filter without requiring the user to author anything.
//
// Adding a new server here = supported out of the box. Project-specific
// overrides still go in .fluxo/mcp_servers.json (workspace JSON wins on
// collisions per v8.19.0 merge rules).
Object.defineProperty(exports, "__esModule", { value: true });
exports.OFFICIAL_REGISTRY = void 0;
exports.listRegistry = listRegistry;
exports.getRegistryEntry = getRegistryEntry;
exports.getStarterPack = getStarterPack;
exports.resolvePlaceholders = resolvePlaceholders;
exports.OFFICIAL_REGISTRY = {
    memory: {
        alias: 'memory',
        description: 'Persistent in-process knowledge graph for agent memory across sessions.',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
        categories: ['pm', 'database'],
        starter: true,
        note: 'No external setup. Stores entities & relations in-memory; restarts wipe state.',
    },
    sqlite: {
        alias: 'sqlite',
        description: 'Read/write access to a local SQLite database file.',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', '${ARG:db_path:./fluxo.db}'],
        categories: ['database'],
        starter: true,
        note: 'Override the db file by editing args[3] (defaults to ./fluxo.db at the workspace root).',
    },
    'brave-search': {
        alias: 'brave-search',
        description: 'Web search via the Brave Search API. Requires BRAVE_API_KEY.',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-brave-search'],
        env: { BRAVE_API_KEY: '${ENV:BRAVE_API_KEY}' },
        categories: ['web'],
        starter: false,
        note: 'Set BRAVE_API_KEY in your shell or replace the ${ENV:...} placeholder with the literal key.',
    },
    filesystem: {
        alias: 'filesystem',
        description: 'Read-only filesystem access scoped to an allow-list of paths.',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '${ARG:root:.}'],
        categories: ['filesystem'],
        starter: false,
        note: 'Replace args[2] with the absolute path you want to expose.',
    },
    github: {
        alias: 'github',
        description: 'GitHub repo, issue, and PR operations. Requires GITHUB_TOKEN.',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${ENV:GITHUB_TOKEN}' },
        categories: ['git', 'github', 'pm'],
        starter: false,
        note: 'Set GITHUB_TOKEN with at least repo scope, or paste the literal token in env.',
    },
};
// ─── Public API ─────────────────────────────────────────────────────────────
/** All known aliases, sorted alphabetically. Used by CLI list output and quickPicks. */
function listRegistry() {
    return Object.values(exports.OFFICIAL_REGISTRY).sort((a, b) => a.alias.localeCompare(b.alias));
}
/** Lookup by alias (case-insensitive). Returns null if unknown. */
function getRegistryEntry(alias) {
    if (!alias) {
        return null;
    }
    const key = alias.trim().toLowerCase();
    return exports.OFFICIAL_REGISTRY[key] ?? null;
}
/**
 * The default starter pack written into a fresh .fluxo/mcp_servers.json the
 * first time the engine boots in a workspace that has never configured MCP.
 * Returns the entries flagged starter:true. This guarantees a useful baseline
 * (memory + sqlite) without forcing the user to read docs.
 */
function getStarterPack() {
    return listRegistry().filter(e => e.starter === true);
}
/**
 * Resolve placeholder syntax in a string.
 *   ${ENV:NAME[:default]} → process.env[NAME] ?? default ?? ''
 *   ${ARG:name:default}   → default
 * The ARG syntax is left intentionally as-is when no default is provided so
 * the user notices and edits the JSON before the server runs.
 */
function resolvePlaceholders(input) {
    return input.replace(/\$\{(ENV|ARG):([A-Za-z_][\w-]*)(?::([^}]*))?\}/g, (match, kind, name, def) => {
        if (kind === 'ENV') {
            const v = process.env[name];
            if (v !== undefined && v !== '') {
                return v;
            }
            return def ?? '';
        }
        // ARG: keep the placeholder when no default — signals the user to edit it.
        return def ?? match;
    });
}
//# sourceMappingURL=mcpRegistry.js.map