import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { NativeTool, ToolResult } from '../shared';

// ─── SecurityAuditTool (v8.28.0 — DevSecOps Token-Free SAST) ────────────────
//
// Static security scanner that runs ENTIRELY in the extension host. Never
// ships repository content to any LLM. The contract with the agent: call
// this tool, read the short report, then act surgically on the findings via
// the existing edit/refactor tools.
//
// Two scanners run in sequence and their findings are concatenated into a
// single report:
//
//   A. Secret Scanner — recursive walk of the workspace (skipping
//      node_modules, .git, .fluxo, dist, build, out, .next, coverage,
//      .vscode, plus binary extensions). For each text file <= MAX_FILE_SIZE
//      bytes, every line is matched against the SECRET_PATTERNS table. A
//      hit emits one finding line: "<relpath>:<line> [<provider>] <preview>".
//      The preview is REDACTED — only the first 12 and last 4 chars survive
//      so the report itself does not become a secrets-disclosure.
//
//   B. NPM Audit — if package.json exists at the workspace root, runs
//      `npm audit --json` via execSync (silent stderr) with a hard timeout.
//      Parses the JSON envelope (npm 7+ format: metadata.vulnerabilities)
//      and reports only the High + Critical counts. Below those severities
//      the noise-to-signal ratio collapses (most npm advisories are dev-only
//      and unactionable inside an editor session).
//
// Output contract:
//   • If both scanners come back empty: "No security issues found. Code is clean."
//   • Otherwise: section headers SECRETS / DEPENDENCIES with bullet findings.
//
// Performance bounds (hard caps, not estimates):
//   • Max files walked        — 5000 (workspace cap, prevents monorepo blowups)
//   • Max walk depth          — 10
//   • Max file size scanned   — 1 MB (binaries / huge generated files skipped)
//   • Max secrets reported    — 200 (after that we stop appending — caller
//                               sees "+N more" footer)
//   • npm audit timeout       — 60 s (cold cache audit can be slow; beyond
//                               that it's almost certainly hung — give up
//                               gracefully and mention the timeout in output)
//
// Skipped extensions: every binary / artifact format we can identify by
// extension. The walker also skips files whose first 1KB contains a NUL
// byte (cheap heuristic to catch unknown-extension binaries — e.g. .pyc
// compiled blobs sitting in non-standard locations).

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.fluxo', 'dist', 'build', 'out',
  '.next', '.nuxt', '.cache', 'coverage', '.vscode', '.idea',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox',
]);

const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
  '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wav',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.pyc', '.class', '.jar', '.war',
  '.lock', '.vsix',
  '.map',  // sourcemaps — high false-positive rate, low signal
]);

interface SecretPattern {
  provider: string;
  re: RegExp;
}

// Patterns are ordered roughly by specificity — high-confidence prefixes
// (sk_live_, AKIA, ghp_, AIzaSy) first; the generic JWT / private key
// patterns last. Each `re` is constructed without the /g flag here; the
// scanLine helper iterates with .exec inside a manual loop.
const SECRET_PATTERNS: SecretPattern[] = [
  { provider: 'Stripe Live Secret Key',     re: /sk_live_[A-Za-z0-9]{24,}/ },
  { provider: 'Stripe Restricted Key',      re: /rk_live_[A-Za-z0-9]{24,}/ },
  { provider: 'Stripe Test Secret Key',     re: /sk_test_[A-Za-z0-9]{24,}/ },
  { provider: 'Google API Key (Firebase)',  re: /AIzaSy[A-Za-z0-9_-]{33}/ },
  { provider: 'GitHub Personal Access',     re: /ghp_[A-Za-z0-9]{36}/ },
  { provider: 'GitHub Fine-Grained PAT',    re: /github_pat_[A-Za-z0-9_]{82}/ },
  { provider: 'GitHub OAuth Token',         re: /gho_[A-Za-z0-9]{36}/ },
  { provider: 'AWS Access Key ID',          re: /\bAKIA[0-9A-Z]{16}\b/ },
  { provider: 'OpenAI API Key',             re: /sk-[A-Za-z0-9]{20,}/ },
  { provider: 'Anthropic API Key',          re: /sk-ant-[A-Za-z0-9_-]{40,}/ },
  { provider: 'Slack Token',                re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { provider: 'Slack Webhook URL',          re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/ },
  { provider: 'Discord Webhook',            re: /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/ },
  { provider: 'JSON Web Token',             re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { provider: 'Private Key (PEM)',          re: /-----BEGIN (?:RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----/ },
];

const MAX_FILES        = 5000;
const MAX_DEPTH        = 10;
const MAX_FILE_SIZE    = 1_000_000;     // 1 MB
const MAX_SECRETS      = 200;
const NPM_AUDIT_TIMEOUT_MS = 60_000;

interface SecretHit {
  relpath: string;
  line: number;
  provider: string;
  redactedPreview: string;
}

// Redact a matched secret to "<first12>…<last4>" so the audit report itself
// is safe to paste into an LLM context, into a screenshot, or into a Slack
// thread. Short matches (< 16 chars total) get fully masked except first 4
// chars to preserve enough signal for triage.
function redactSecret(raw: string): string {
  if (raw.length <= 16) {
    return raw.slice(0, 4) + '…[redacted]';
  }
  return `${raw.slice(0, 12)}…${raw.slice(-4)}`;
}

function isLikelyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) { return true; }
  }
  return false;
}

function scanFile(absPath: string, relpath: string, hits: SecretHit[]): void {
  let buf: Buffer;
  try {
    const stat = fs.statSync(absPath);
    if (stat.size === 0 || stat.size > MAX_FILE_SIZE) { return; }
    buf = fs.readFileSync(absPath);
  } catch {
    return;
  }
  if (isLikelyBinary(buf)) { return; }

  const text = buf.toString('utf-8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (hits.length >= MAX_SECRETS) { return; }
    const line = lines[i];
    if (line.length > 4000) { continue; } // skip pathological minified lines
    for (const pattern of SECRET_PATTERNS) {
      const match = pattern.re.exec(line);
      if (match) {
        hits.push({
          relpath,
          line: i + 1,
          provider: pattern.provider,
          redactedPreview: redactSecret(match[0]),
        });
        break; // one finding per line is enough — avoid double-reporting
      }
    }
  }
}

interface WalkState {
  filesWalked: number;
  hits: SecretHit[];
  workspacePath: string;
  reachedFileCap: boolean;
  reachedSecretCap: boolean;
}

function walkSecrets(dir: string, depth: number, state: WalkState): void {
  if (depth > MAX_DEPTH) { return; }
  if (state.filesWalked >= MAX_FILES) { state.reachedFileCap = true; return; }
  if (state.hits.length >= MAX_SECRETS) { state.reachedSecretCap = true; return; }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (state.filesWalked >= MAX_FILES) { state.reachedFileCap = true; return; }
    if (state.hits.length >= MAX_SECRETS) { state.reachedSecretCap = true; return; }
    const name = entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name)) { continue; }
      walkSecrets(path.join(dir, name), depth + 1, state);
      continue;
    }
    if (!entry.isFile()) { continue; }
    const ext = path.extname(name).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) { continue; }
    state.filesWalked++;
    const absPath = path.join(dir, name);
    const relpath = path.relative(state.workspacePath, absPath).replace(/\\/g, '/');
    scanFile(absPath, relpath, state.hits);
  }
}

interface NpmAuditSummary {
  ran: boolean;
  high: number;
  critical: number;
  totalAdvisories: number;
  error?: string;
}

function runNpmAudit(workspacePath: string): NpmAuditSummary {
  const pkgPath = path.join(workspacePath, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { ran: false, high: 0, critical: 0, totalAdvisories: 0 };
  }

  let raw: string;
  try {
    // npm audit exits with code 1 when vulnerabilities exist, which causes
    // execSync to throw — we still want the JSON body in that case, so we
    // catch and read err.stdout. The audit JSON is on stdout regardless of
    // exit code.
    raw = execSync('npm audit --json', {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: NPM_AUDIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 8,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err: any) {
    raw = err?.stdout ? String(err.stdout) : '';
    if (!raw && err?.code === 'ETIMEDOUT') {
      return { ran: true, high: 0, critical: 0, totalAdvisories: 0, error: 'npm audit timed out (60s) — registry unreachable or huge dep tree' };
    }
    if (!raw) {
      return { ran: true, high: 0, critical: 0, totalAdvisories: 0, error: `npm audit failed: ${err?.message ?? String(err)}` };
    }
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ran: true, high: 0, critical: 0, totalAdvisories: 0, error: 'npm audit returned non-JSON output' };
  }

  // npm 7+ shape: { metadata: { vulnerabilities: { info, low, moderate, high, critical, total } } }
  const v = parsed?.metadata?.vulnerabilities ?? {};
  return {
    ran: true,
    high: typeof v.high === 'number' ? v.high : 0,
    critical: typeof v.critical === 'number' ? v.critical : 0,
    totalAdvisories: typeof v.total === 'number' ? v.total : 0,
  };
}

function buildReport(hits: SecretHit[], walkState: WalkState, audit: NpmAuditSummary): string {
  const sections: string[] = [];

  if (hits.length > 0) {
    const header = `SECRETS — ${hits.length} hardcoded secret(s) detected:`;
    const bullets = hits.map(h => `- ${h.relpath}:${h.line} [${h.provider}] ${h.redactedPreview}`);
    if (walkState.reachedSecretCap) {
      bullets.push(`- …(stopped at MAX_SECRETS=${MAX_SECRETS}; rerun after fixing the first batch)`);
    }
    sections.push([header, '', ...bullets].join('\n'));
  }

  if (audit.ran && (audit.high > 0 || audit.critical > 0)) {
    const lines = [
      `DEPENDENCIES (npm audit) — ${audit.critical} critical, ${audit.high} high (${audit.totalAdvisories} total advisories)`,
      '',
      `- Run \`npm audit\` in the terminal for the full list and \`npm audit fix\` to auto-patch what is safely updatable.`,
      `- For breaking patches, review the advisory before forcing the upgrade.`,
    ];
    sections.push(lines.join('\n'));
  } else if (audit.ran && audit.error) {
    sections.push(`DEPENDENCIES (npm audit) — ${audit.error}`);
  }

  if (sections.length === 0) {
    return 'No security issues found. Code is clean.';
  }

  const footer: string[] = [];
  if (walkState.reachedFileCap) {
    footer.push(`(walked ${walkState.filesWalked} files — workspace cap of ${MAX_FILES} reached; some files were not scanned)`);
  }

  return [
    `[security_audit] ${hits.length} secret(s) + ${audit.high + audit.critical} high/critical dependency advisor(ies):`,
    '',
    ...sections.map(s => s + '\n'),
    ...footer,
  ].join('\n').trim();
}

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'security_audit',
    description:
      'Static Application Security Testing (SAST) scanner that runs ENTIRELY in the extension host. ' +
      'Never sends repository content to any LLM — only the short findings report. ' +
      'TWO scanners: (A) Secret Scanner walks the workspace (skipping node_modules / .git / .fluxo / ' +
      'dist / build / out / .next / coverage and binary extensions) matching every line against a ' +
      'curated table of known secret formats (Stripe, Firebase/Google, GitHub PAT, AWS, OpenAI, ' +
      'Anthropic, Slack, JWT, PEM private keys, etc.). Reports file:line plus a REDACTED preview of ' +
      'each match — the report itself never leaks the secret. (B) NPM Audit runs `npm audit --json` ' +
      'silently if package.json exists, returns only the High + Critical counts. ' +
      'WHEN TO USE: any user request to "audit", "scan for vulnerabilities", "find leaked secrets", ' +
      '"check for exposed API keys", or "run a security review". ' +
      'WHEN NOT TO USE: do not call as part of unrelated tasks — the scanner walks up to 5000 files ' +
      'and runs npm audit which can take 30-60s on a cold cache. ' +
      'NO PARAMETERS — the tool always scans the workspace root.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
};

export function execute(_args: Record<string, any>, workspacePath: string): ToolResult {
  if (!workspacePath) {
    return { success: false, output: 'security_audit: no workspace open.' };
  }

  const walkState: WalkState = {
    filesWalked: 0,
    hits: [],
    workspacePath,
    reachedFileCap: false,
    reachedSecretCap: false,
  };

  try {
    walkSecrets(workspacePath, 0, walkState);
  } catch (err: any) {
    return { success: false, output: `security_audit: secret-scan failed: ${err?.message ?? String(err)}` };
  }

  const audit = runNpmAudit(workspacePath);
  const report = buildReport(walkState.hits, walkState, audit);

  // Success regardless of findings — the agent needs the report either way.
  // Failure status is reserved for the tool itself crashing (caught above).
  return { success: true, output: report };
}
