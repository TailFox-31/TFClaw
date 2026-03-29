#!/usr/bin/env bash
# Build the EJClaw reviewer container image
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building ejclaw-reviewer container image..."
docker build -t ejclaw-reviewer:latest .
echo "Done. Image: ejclaw-reviewer:latest"
