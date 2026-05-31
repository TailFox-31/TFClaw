#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="${ROOT_DIR}/backend"
FRONTEND_DIR="${ROOT_DIR}/frontend"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-ChangeMe123!}"

if ! command -v python3 >/dev/null 2>&1; then
    echo "[ERROR] python3 is required."
    exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
    echo "[ERROR] npm is required."
    exit 1
fi

if [[ ! -f "${ROOT_DIR}/.env" ]]; then
    cp "${ROOT_DIR}/.env.example" "${ROOT_DIR}/.env"
fi

cd "${BACKEND_DIR}"

PYTHON_BIN=""
if [[ -x ".venv/bin/python" ]]; then
    PYTHON_BIN="${BACKEND_DIR}/.venv/bin/python"
elif python3 -m venv .venv >/dev/null 2>&1; then
    PYTHON_BIN="${BACKEND_DIR}/.venv/bin/python"
else
    mkdir -p .deps
    python3 -m pip install --target .deps -r requirements.txt
    export PYTHONPATH="${BACKEND_DIR}/.deps:${BACKEND_DIR}:${PYTHONPATH:-}"
    PYTHON_BIN="python3"
fi

if [[ "${PYTHON_BIN}" == *".venv/bin/python" ]]; then
    "${PYTHON_BIN}" -m pip install -r requirements.txt
fi

"${PYTHON_BIN}" scripts/create_admin.py "${ADMIN_USER}" "${ADMIN_PASSWORD}"

cd "${FRONTEND_DIR}"
if [[ ! -d "node_modules" ]]; then
    npm install
fi

cleanup() {
    [[ -n "${BACKEND_PID:-}" ]] && kill "${BACKEND_PID}" 2>/dev/null || true
    [[ -n "${FRONTEND_PID:-}" ]] && kill "${FRONTEND_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd "${BACKEND_DIR}"
"${PYTHON_BIN}" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 &
BACKEND_PID=$!

cd "${FRONTEND_DIR}"
npm run dev:lan -- --port 5173 &
FRONTEND_PID=$!

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "Local URL: http://127.0.0.1:5173/"
if [[ -n "${LAN_IP}" ]]; then
    echo "LAN URL:   http://${LAN_IP}:5173/"
fi
echo "Login:     ${ADMIN_USER} / ${ADMIN_PASSWORD}"
echo

wait
