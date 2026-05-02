import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';
import { initialize, validateTasks, renderMarkdown, Task } from '../../utils/dagController';

// ─── propose_plan (v8.17.0 — DAG Orchestrator) ──────────────────────────────
// The @manager no longer hands off a flat markdown string. It must structure
// its intent as a Directed Acyclic Graph of Task objects with explicit
// dependencies. The tool persists the graph to .fluxo/dag_state.json (the new
// source of truth) and projects a human-readable IMPLEMENTATION_PLAN.md from
// it for the user to review before execution starts.

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'propose_plan',
    description:
      'Propose a structured Directed Acyclic Graph (DAG) of tasks for a complex assignment. ' +
      'Each task declares its target agent, description, and parent dependencies. The engine ' +
      'persists the graph to .fluxo/dag_state.json and renders a human-readable IMPLEMENTATION_PLAN.md ' +
      'so the user can review the plan before execution begins. Use this BEFORE any major change.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description:
            'Ordered list of tasks that form the DAG. Each task must have a unique id and may declare ' +
            'depends_on with the ids of tasks that must be COMPLETED before it can run.',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Stable, unique identifier for this task (e.g. "T1", "setup-db").',
              },
              description: {
                type: 'string',
                description: 'Imperative description of what the assigned agent must accomplish.',
              },
              agent_type: {
                type: 'string',
                description: 'Target agent (e.g. "@coder", "@designer", "@manager", "@planner").',
              },
              depends_on: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of task ids that must be COMPLETED before this task is dispatched. Empty array for root tasks.',
              },
            },
            required: ['id', 'description', 'agent_type', 'depends_on'],
          },
        },
      },
      required: ['tasks'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const rawTasks = args.tasks;
  if (!Array.isArray(rawTasks)) {
    return {
      success: false,
      output:
        'propose_plan requires a "tasks" array of structured Task objects (DAG v8.17.0). ' +
        'Each task must declare id, description, agent_type, and depends_on.',
    };
  }

  const validation = validateTasks(rawTasks);
  if (!validation.ok) {
    return { success: false, output: `[DAG VALIDATION ERROR] ${validation.error}` };
  }

  const tasks: Task[] = validation.tasks;
  const state = initialize(workspacePath, tasks);

  // Project the JSON graph into IMPLEMENTATION_PLAN.md so the user keeps a
  // human-readable surface to review and approve before execution.
  const planPath = safePath(workspacePath, path.join('.fluxo', 'IMPLEMENTATION_PLAN.md'));
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, renderMarkdown(state), 'utf-8');

  const rootTasks = tasks.filter(t => t.depends_on.length === 0).map(t => t.id);
  return {
    success: true,
    output:
      `DAG initialized successfully. ${tasks.length} task(s) persisted to .fluxo/dag_state.json. ` +
      `IMPLEMENTATION_PLAN.md generated for human review. ` +
      `Root tasks (no dependencies): ${rootTasks.length > 0 ? rootTasks.join(', ') : '(none)'}. ` +
      `Please review the plan and confirm if I should proceed.`,
  };
}
