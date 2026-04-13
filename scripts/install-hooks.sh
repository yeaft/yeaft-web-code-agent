#!/bin/bash
#
# Install git hooks from the hooks/ directory.
# Run this after cloning the repo.
#
# Usage: bash scripts/install-hooks.sh

set -e

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  echo "ERROR: Not in a git repository"
  exit 1
fi

HOOKS_SRC="$REPO_ROOT/hooks"
HOOKS_DST="$REPO_ROOT/.git/hooks"

if [ ! -d "$HOOKS_SRC" ]; then
  echo "ERROR: hooks/ directory not found at $HOOKS_SRC"
  exit 1
fi

installed=0
for hook in "$HOOKS_SRC"/*; do
  hook_name=$(basename "$hook")
  cp "$hook" "$HOOKS_DST/$hook_name"
  chmod +x "$HOOKS_DST/$hook_name"
  echo "  Installed: $hook_name"
  installed=$((installed + 1))
done

echo ""
echo "Done. $installed hook(s) installed to .git/hooks/"
