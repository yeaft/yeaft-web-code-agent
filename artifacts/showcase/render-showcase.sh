#!/bin/sh
# Optional QA: render the actual PPTX, not an HTML approximation.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
IMAGE=${SHOWCASE_RENDER_IMAGE:-yeaft-showcase-renderer:bookworm}
usage() {
  cat <<'EOF'
Usage:
  sh artifacts/showcase/render-showcase.sh --build-image
  sh artifacts/showcase/render-showcase.sh [input.pptx] [output-parent]

Requires a local Docker daemon. Build the isolated image explicitly once.
Each render creates a fresh run directory under output-parent (default:
<worktree>/tmpclaude-showcase-preview, ignored by Git). Outputs: deck.pdf,
page-01.png ... page-08.png (144 DPI), contact-sheet.png, render-report.json.
No global packages, application services, or runtime data are changed.
SHOWCASE_RENDER_IMAGE overrides the local image tag. Remove it when finished
with: docker image rm yeaft-showcase-renderer:bookworm
EOF
}
if [ "${1:-}" = --help ]; then usage; exit 0; fi
command -v docker >/dev/null 2>&1 || { echo 'Missing dependency: docker' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'A reachable local Docker daemon is required.' >&2; exit 1; }
if [ "${1:-}" = --build-image ]; then
  [ "$#" -eq 1 ] || { usage >&2; exit 1; }
  # Stdin Dockerfile: never send the repository as Docker build context.
  docker build -t "$IMAGE" - < "$SCRIPT_DIR/render-showcase.Dockerfile"
  exit 0
fi
[ "$#" -le 2 ] || { usage >&2; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo 'Missing renderer image. Run render-showcase.sh --build-image explicitly.' >&2
  exit 1
}
INPUT=${1:-$SCRIPT_DIR/yeaft-work-anywhere.pptx}
[ -f "$INPUT" ] || { echo "Missing PPTX: $INPUT" >&2; exit 1; }
INPUT=$(CDPATH= cd -- "$(dirname -- "$INPUT")" && pwd)/$(basename -- "$INPUT")
OUTPUT_PARENT=${2:-$ROOT/tmpclaude-showcase-preview}
mkdir -p -- "$OUTPUT_PARENT"
OUTPUT_PARENT=$(CDPATH= cd -- "$OUTPUT_PARENT" && pwd)
case "$INPUT$OUTPUT_PARENT$SCRIPT_DIR" in
  *,*) echo 'Docker bind paths must not contain commas.' >&2; exit 1 ;;
esac
OUTPUT=$(mktemp -d "$OUTPUT_PARENT/render-XXXXXXXX")
printf 'Rendering to %s\n' "$OUTPUT"
# Only the input, renderer script, and fresh QA output are mounted. The
# disposable container has no network, privileges, or writable root filesystem.
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --user "$(id -u):$(id -g)" \
  --memory 2g --cpus 2 --pids-limit 256 \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --mount "type=bind,src=$INPUT,dst=/input/deck.pptx,readonly" \
  --mount "type=bind,src=$SCRIPT_DIR/render-showcase.py,dst=/renderer/render-showcase.py,readonly" \
  --mount "type=bind,src=$OUTPUT,dst=/output" \
  "$IMAGE"
printf 'Verified render: %s\n' "$OUTPUT"
