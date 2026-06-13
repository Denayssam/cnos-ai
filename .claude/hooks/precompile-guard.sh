#!/usr/bin/env bash
#
# precompile-guard.sh — PreToolUse guard for the cnos-extension (Fluxo AI) repo.
#
# Blocks `git commit`, `vsce package`, and `npm run package` whenever the
# TypeScript build (`npm run compile`) fails, so a broken build can never be
# committed or shipped. Wired via the project's .claude/settings.json
# (matcher: "Bash|PowerShell"). Reads the hook payload as JSON on stdin.
#
# Exit codes:
#   0  allow  — command is not guarded, OR the build passed
#   2  block  — guarded command + build failed (stderr is shown to Claude)
#
set -uo pipefail

payload="$(cat)"

# Extract tool_input.command from the hook JSON. jq is not installed on this
# host, but node always is (this is a Node project), and node parses JSON
# correctly even when the command embeds escaped quotes, e.g. commit -m "...".
cmd="$(printf '%s' "$payload" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);process.stdout.write((j.tool_input&&j.tool_input.command)||"");}catch(e){}});')"

# Only guard commit / package commands; anything else passes straight through.
# The verb is matched anywhere in the command so chained forms are caught too,
# e.g.  git add . && git commit -m "x".
if ! printf '%s' "$cmd" | grep -Eq '(^|[;&|]|[[:space:]])(git[[:space:]]+commit|vsce[[:space:]]+package|npm[[:space:]]+run[[:space:]]+package)([[:space:]]|$)'; then
  exit 0
fi

# Run the TypeScript build in the project root.
proj="${CLAUDE_PROJECT_DIR:-$PWD}"
build_output="$(cd "$proj" && npm run compile 2>&1)"
build_status=$?

if [ "$build_status" -ne 0 ]; then
  {
    echo "BLOCKED by precompile-guard: 'npm run compile' failed (exit ${build_status})."
    echo "Fix the TypeScript errors before committing or packaging."
    echo
    echo "----- last lines of build output -----"
    printf '%s\n' "$build_output" | tail -n 25
  } >&2
  exit 2
fi

# Build is green — let the command proceed through the normal flow.
exit 0
