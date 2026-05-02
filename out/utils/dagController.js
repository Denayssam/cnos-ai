"use strict";
// ─── DAG Controller (v8.17.0 — Phase 1) ─────────────────────────────────────
// Central state manager for the @manager's Directed Acyclic Graph orchestration.
// Replaces the legacy flat IMPLEMENTATION_PLAN.md with a structured task graph
// persisted at .fluxo/dag_state.json. Every task carries explicit dependencies,
// so the engine can resolve which tasks are unblocked at any iteration without
// asking the LLM to re-derive ordering on each turn.
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
exports.validateTasks = validateTasks;
exports.initialize = initialize;
exports.read = read;
exports.updateTaskStatus = updateTaskStatus;
exports.getReadyTasks = getReadyTasks;
exports.exists = exists;
exports.appendTask = appendTask;
exports.getCurrentInProgressTask = getCurrentInProgressTask;
exports.renderMarkdown = renderMarkdown;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const DAG_DIR_NAME = '.fluxo';
const DAG_FILE_NAME = 'dag_state.json';
const SCHEMA_VERSION = 1;
function dagFilePath(workspacePath) {
    return path.join(workspacePath, DAG_DIR_NAME, DAG_FILE_NAME);
}
function ensureDir(workspacePath) {
    fs.mkdirSync(path.join(workspacePath, DAG_DIR_NAME), { recursive: true });
}
// ─── Validation ─────────────────────────────────────────────────────────────
const VALID_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED'];
function validateTasks(tasks) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
        return { ok: false, error: 'tasks must be a non-empty array.' };
    }
    const seenIds = new Set();
    const normalized = [];
    for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        if (!t || typeof t !== 'object') {
            return { ok: false, error: `Task #${i} is not an object.` };
        }
        if (typeof t.id !== 'string' || !t.id.trim()) {
            return { ok: false, error: `Task #${i} is missing a non-empty 'id' string.` };
        }
        if (seenIds.has(t.id)) {
            return { ok: false, error: `Duplicate task id "${t.id}". Every task id must be unique.` };
        }
        seenIds.add(t.id);
        if (typeof t.description !== 'string' || !t.description.trim()) {
            return { ok: false, error: `Task "${t.id}" is missing a non-empty 'description'.` };
        }
        if (typeof t.agent_type !== 'string' || !t.agent_type.trim()) {
            return { ok: false, error: `Task "${t.id}" is missing a non-empty 'agent_type' (e.g. '@coder').` };
        }
        const status = (t.status && VALID_STATUSES.includes(t.status))
            ? t.status
            : 'PENDING';
        const depends_on = Array.isArray(t.depends_on) ? t.depends_on.filter((d) => typeof d === 'string') : [];
        normalized.push({
            id: t.id.trim(),
            description: t.description.trim(),
            agent_type: t.agent_type.trim(),
            status,
            depends_on,
        });
    }
    // Verify every dependency points to a known task id and there are no cycles.
    for (const t of normalized) {
        for (const dep of t.depends_on) {
            if (!seenIds.has(dep)) {
                return { ok: false, error: `Task "${t.id}" depends on unknown task id "${dep}".` };
            }
            if (dep === t.id) {
                return { ok: false, error: `Task "${t.id}" cannot depend on itself.` };
            }
        }
    }
    if (hasCycle(normalized)) {
        return { ok: false, error: 'Dependency graph contains a cycle. The DAG must be acyclic.' };
    }
    return { ok: true, tasks: normalized };
}
function hasCycle(tasks) {
    const adj = new Map();
    for (const t of tasks) {
        adj.set(t.id, t.depends_on);
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    for (const t of tasks) {
        color.set(t.id, WHITE);
    }
    function dfs(id) {
        color.set(id, GRAY);
        for (const dep of adj.get(id) ?? []) {
            const c = color.get(dep) ?? WHITE;
            if (c === GRAY) {
                return true;
            }
            if (c === WHITE && dfs(dep)) {
                return true;
            }
        }
        color.set(id, BLACK);
        return false;
    }
    for (const t of tasks) {
        if ((color.get(t.id) ?? WHITE) === WHITE) {
            if (dfs(t.id)) {
                return true;
            }
        }
    }
    return false;
}
// ─── Persistence ────────────────────────────────────────────────────────────
function initialize(workspacePath, tasks) {
    ensureDir(workspacePath);
    const now = new Date().toISOString();
    const state = {
        version: SCHEMA_VERSION,
        created_at: now,
        updated_at: now,
        tasks,
    };
    fs.writeFileSync(dagFilePath(workspacePath), JSON.stringify(state, null, 2), 'utf-8');
    return state;
}
function read(workspacePath) {
    const fp = dagFilePath(workspacePath);
    if (!fs.existsSync(fp)) {
        return null;
    }
    try {
        const raw = fs.readFileSync(fp, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.tasks)) {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
function write(workspacePath, state) {
    state.updated_at = new Date().toISOString();
    fs.writeFileSync(dagFilePath(workspacePath), JSON.stringify(state, null, 2), 'utf-8');
}
function updateTaskStatus(workspacePath, taskId, status, result) {
    const state = read(workspacePath);
    if (!state) {
        return false;
    }
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) {
        return false;
    }
    task.status = status;
    if (result !== undefined) {
        task.result = result;
    }
    const now = new Date().toISOString();
    if (status === 'IN_PROGRESS' && !task.started_at) {
        task.started_at = now;
    }
    if (status === 'COMPLETED' || status === 'FAILED') {
        task.completed_at = now;
    }
    write(workspacePath, state);
    return true;
}
// ─── Dispatch Resolution ────────────────────────────────────────────────────
// A task is "ready" when its status is PENDING and EVERY task listed in
// depends_on has reached the COMPLETED status. The dispatcher does not mutate
// the graph — it only reports which tasks are unblocked. The agentEngine is
// responsible for promoting them to IN_PROGRESS once it actually delegates.
function getReadyTasks(workspacePath) {
    const state = read(workspacePath);
    if (!state) {
        return [];
    }
    const completed = new Set(state.tasks.filter(t => t.status === 'COMPLETED').map(t => t.id));
    return state.tasks.filter(t => t.status === 'PENDING' && t.depends_on.every(dep => completed.has(dep)));
}
function exists(workspacePath) {
    return fs.existsSync(dagFilePath(workspacePath));
}
/**
 * Append a single task to the live DAG. Returns the new Task on success or
 * null if no DAG exists / the file is unreadable. The new task always starts
 * in PENDING status; the dispatcher will pick it up on the next iteration
 * tick once its depends_on parents are COMPLETED.
 */
function appendTask(workspacePath, input) {
    const state = read(workspacePath);
    if (!state) {
        return null;
    }
    const prefix = (input.idPrefix ?? 'auto').replace(/[^a-zA-Z0-9_-]/g, '');
    const existingIds = new Set(state.tasks.map(t => t.id));
    let n = state.tasks.length + 1;
    let id = `${prefix}-${n}`;
    while (existingIds.has(id)) {
        n++;
        id = `${prefix}-${n}`;
    }
    const newTask = {
        id,
        description: input.description,
        agent_type: input.agent_type,
        status: 'PENDING',
        depends_on: Array.isArray(input.depends_on) ? input.depends_on.filter(d => existingIds.has(d)) : [],
    };
    state.tasks.push(newTask);
    write(workspacePath, state);
    return newTask;
}
/**
 * Find the most recently-started IN_PROGRESS task in the DAG. Used by
 * ExitWorktreeTool to identify which task "owns" the merge attempt that
 * just failed, so the auto-injected conflict-resolution task can list it as
 * a dependency. Returns null if the DAG is missing or no task is in flight.
 */
function getCurrentInProgressTask(workspacePath) {
    const state = read(workspacePath);
    if (!state) {
        return null;
    }
    const inFlight = state.tasks.filter(t => t.status === 'IN_PROGRESS');
    if (inFlight.length === 0) {
        return null;
    }
    inFlight.sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));
    return inFlight[0];
}
// ─── Human-readable rendering ───────────────────────────────────────────────
// Used by ProposePlanTool to keep IMPLEMENTATION_PLAN.md alive as a review
// surface for the user — the JSON is the source of truth, the markdown is the
// projection humans actually read.
function renderMarkdown(state) {
    const lines = [];
    lines.push('# 📋 Implementation Plan — DAG Orchestration');
    lines.push('');
    lines.push(`> Generated by @manager via the DAG Controller (v${state.version}).`);
    lines.push(`> Source of truth: \`.fluxo/dag_state.json\`. This document is a human-readable projection.`);
    lines.push(`> Created: ${state.created_at} · Updated: ${state.updated_at}`);
    lines.push('');
    lines.push(`**Total tasks:** ${state.tasks.length}`);
    lines.push('');
    lines.push('## Task Graph');
    lines.push('');
    for (const task of state.tasks) {
        const depList = task.depends_on.length > 0
            ? task.depends_on.map(d => `\`${d}\``).join(', ')
            : '_(no dependencies — root task)_';
        lines.push(`### \`${task.id}\` — ${task.description}`);
        lines.push('');
        lines.push(`- **Agent:** ${task.agent_type}`);
        lines.push(`- **Status:** ${task.status}`);
        lines.push(`- **Depends on:** ${depList}`);
        lines.push('');
    }
    return lines.join('\n');
}
//# sourceMappingURL=dagController.js.map