#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERDR_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

mkdir -p "$HERDR_HOME/layouts" "$HERDR_HOME/mods"

ln -sfn "$REPO_DIR/layouts/my-herdr.json" "$HERDR_HOME/layouts/my-herdr.json"

for mod in files-search file-viewer pane-custom system-monitor changes-history; do
  target="$HERDR_HOME/mods/$mod"
  if [ -d "$target" ] && [ ! -L "$target" ]; then
    rm -rf "$target"
  fi
  ln -sfn "$REPO_DIR/mods/$mod" "$target"
done

# Remove legacy tiling-mode symlink if present
rm -rf "$HERDR_HOME/mods/tiling-mode"

node "$REPO_DIR/scripts/apply-keys.js"

echo "Linked my-herdr layout and mods into $HERDR_HOME"
echo "Validating mods..."
for mod in files-search file-viewer pane-custom system-monitor changes-history; do
  herdr-app check "$HERDR_HOME/mods/$mod"
done
echo "Done. Switch layout with: herdr-app do layout.switch '{\"name\":\"my-herdr\"}'"
