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
exports.Sentinel = void 0;
const vscode = __importStar(require("vscode"));
// ─── ANSI / Control Sequence Stripper ────────────────────────────────────────
// Covers: CSI (\x1b[...m), OSC (\x1b]...\x07), DCS/SOS/PM/APC, and lone Fe
const ANSI_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07|[PX^_].*?\x1b\\|[@-_])/g;
function stripAnsi(raw) {
    return raw.replace(ANSI_RE, '').replace(/\r/g, '');
}
// ─── Error Detection Patterns ─────────────────────────────────────────────────
const ERROR_PATTERNS = [
    /error\s*TS\d+:/i, // TypeScript compiler  e.g.  error TS2345:
    /failed to compile/i, // Vite / CRA
    /failed to resolve import/i, // Vite missing module
    /\[vite\].*error/i, // Vite runtime HMR error
    /\[plugin:vite:oxc\]/i, // Vite OXC parser plugin error (Vite 6+)
    /\bparse_error\b/i, // OXC / SWC / esbuild parse error
    /\bsyntaxerror\b/i, // JS SyntaxError
    /\breferenceerror\b/i, // JS ReferenceError
    /\btypeerror\b/i, // JS TypeError
    /build failed/i, // Generic build failure
    /compilation failed/i, // tsc / webpack
    /npm err!/i, // npm
    /✗.*\berror\b/i, // Vite ✗ error prefix
    /error\s+in\s+\S+\.(ts|tsx|js|jsx)/i, // "Error in src/foo.ts"
    /\berror\b.*\.(ts|tsx|js|jsx):\d+/i, // "Error  src/foo.ts:42"
];
// ─── Tuning Constants ─────────────────────────────────────────────────────────
const BUFFER_MAX = 4096; // Keep only the last 4 KB of terminal output
const DEBOUNCE_MS = 2000; // Wait 2 s of silence after last error chunk before firing
const COOLDOWN_MS = 30000; // After firing, ignore terminal for 30 s (avoid re-trigger loops)
// ─── Sentinel Class ───────────────────────────────────────────────────────────
class Sentinel {
    constructor(onError) {
        this.onError = onError;
        this._buffer = '';
        this._active = false;
        this._debounce = null;
        this._cooldownUntil = 0;
        this._disposable = null;
    }
    get isActive() { return this._active; }
    activate() {
        if (this._active) {
            return;
        }
        this._active = true;
        this._buffer = '';
        const termEvent = vscode.window.onDidWriteTerminalData;
        if (termEvent) {
            this._disposable = termEvent(e => this._onData(e.data));
        }
        else {
            vscode.window.showWarningMessage('CNOS Sentinel: Terminal monitoring requires VS Code 1.88+. Please update VS Code to enable auto-heal.');
        }
    }
    deactivate() {
        if (!this._active) {
            return;
        }
        this._active = false;
        this._buffer = '';
        if (this._debounce) {
            clearTimeout(this._debounce);
            this._debounce = null;
        }
        this._disposable?.dispose();
        this._disposable = null;
    }
    /** Toggle active state. Returns the new state. */
    toggle() {
        if (this._active) {
            this.deactivate();
        }
        else {
            this.activate();
        }
        return this._active;
    }
    dispose() { this.deactivate(); }
    _onData(raw) {
        if (!this._active) {
            return;
        }
        if (Date.now() < this._cooldownUntil) {
            return;
        } // Still in post-fire cooldown
        const clean = stripAnsi(raw);
        if (!clean.trim()) {
            return;
        }
        // Append to rolling buffer, trimming from the front when over ceiling
        this._buffer += clean;
        if (this._buffer.length > BUFFER_MAX) {
            this._buffer = this._buffer.slice(this._buffer.length - BUFFER_MAX);
        }
        // Only arm the debounce if the buffer actually contains an error signal
        if (!ERROR_PATTERNS.some(p => p.test(this._buffer))) {
            return;
        }
        // Reset the debounce timer on every new chunk — fire only after silence
        if (this._debounce) {
            clearTimeout(this._debounce);
        }
        this._debounce = setTimeout(() => {
            this._debounce = null;
            const snapshot = this._buffer.trim();
            this._buffer = '';
            this._cooldownUntil = Date.now() + COOLDOWN_MS;
            this.onError(snapshot);
        }, DEBOUNCE_MS);
    }
}
exports.Sentinel = Sentinel;
//# sourceMappingURL=sentinel.js.map