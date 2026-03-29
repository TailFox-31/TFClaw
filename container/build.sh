#!/usr/bin/env bash
# Build the EJClaw reviewer container image
# Runs from project root so Dockerfile can COPY runners/agent-runner/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Building ejclaw-reviewer container image..."
docker build -f "$SCRIPT_DIR/Dockerfile" -t ejclaw-reviewer:latest "$PROJECT_ROOT"
echo "Done. Image: ejclaw-reviewer:latest"
