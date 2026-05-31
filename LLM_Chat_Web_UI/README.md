# LLM Chat Web UI

Closed-network chat Web UI for an internal LLM server.

## Goal

This repository provides a first-phase Web UI that lets employees log in,
passes device access checks through a server-side whitelist, and stores chat
history. It is designed for later integration with an air-gapped LLM endpoint.

For local development before the closed-network LLM exists, the backend runs in
mock mode by default. The same UI can later point to an OpenAI-compatible
server, Anthropic Claude, or Google Gemini by changing environment variables.

## Phase 1 Scope

- Browser-based login.
- Server-side user accounts.
- Device whitelist by client certificate fingerprint and/or IP CIDR.
- Chat UI similar to common AI chat products.
- Conversation and message history.
- Local mock chat mode for immediate Web UI testing.
- OpenAI-compatible LLM API integration for later model wiring.
- Anthropic Claude API integration for temporary external testing.
- Google Gemini API integration for temporary external testing.
- Responsive layout for FHD, QHD, and 4K displays.

Browsers cannot read local MAC addresses or hardware IDs directly. In phase 1,
device trust should come from one of these server-side controls:

- mTLS client certificate, with a reverse proxy forwarding a verified
  certificate fingerprint.
- Fixed internal IP ranges, if the network is already segmented.
- Existing NAC/proxy controls in front of the Web UI.

## Phase 2 Scope

Phase 2 adds an optional local device agent. The agent can collect MAC address,
hardware ID, disk serial, TPM identity, or other site-approved identifiers and
submit an attested device token to this backend.

See `agents/README.md`.

## Repository Layout

```text
backend/          FastAPI API server and SQLite persistence
frontend/         React/Vite chat UI
agents/           Phase 2 local agent design notes
docs/             Architecture, security, and deployment notes
```

## Local Development

Fast local start:

```bash
./scripts/run_local_linux.sh
```

On Windows, open PowerShell in the repository root:

```powershell
.\scripts\run_local_windows.ps1
```

Or double-click:

```text
scripts\run_local_windows.bat
```

The scripts install backend/frontend dependencies, create or update the default
admin account, and start both servers.

Backend:

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python scripts/create_admin.py admin 'ChangeMe123!'
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

If `python3-venv` is not installed on the target machine, use a local dependency
directory instead:

```bash
cd backend
python3 -m pip install --target .deps -r requirements.txt
PYTHONPATH=.deps:. python3 scripts/create_admin.py admin 'ChangeMe123!'
PYTHONPATH=.deps:. python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Default API URL for the frontend is `/api`. In development, Vite proxies this
to `http://127.0.0.1:8000`.

Open the UI:

```text
http://127.0.0.1:5173
```

For access from another Windows or Linux PC on the same network, run the
frontend on all interfaces:

```bash
cd frontend
npm run dev:lan -- --port 5173
```

Then open this from the client PC browser:

```text
http://SERVER_IP:5173
```

The backend can stay bound to `127.0.0.1:8000` in development because the Vite
server proxies `/api` to it. In production, serve `frontend/dist` and `/api`
through the same reverse proxy so Windows and Linux clients use the same URL.

Default local test login:

```text
username: admin
password: ChangeMe123!
```

## LLM Modes

This Web UI cannot directly attach to the current Discord Codex/Claude room.
That room is not exposed as an HTTP API. Temporary use must go through model
provider APIs.

Register API keys in `.env` at the repository root:

```bash
cp .env.example .env
```

Then edit `.env`. Do not put API keys in frontend files.

Admins can also set the provider and API key from the Web UI: log in as
`admin`, click the settings button in the top-right header, choose the provider,
paste the API key, and save. Blank API key fields keep the existing key.

Default local mock mode:

```bash
LLM_MOCK=true
LLM_PROVIDER=mock
```

OpenAI-compatible endpoint mode, for an OpenAI account, compatible gateway, or
future closed-network LLM:

```bash
LLM_MOCK=false
LLM_PROVIDER=openai
LLM_API_BASE=http://127.0.0.1:8001/v1
LLM_API_KEY=
LLM_MODEL=local-model
```

Anthropic Claude mode:

```bash
LLM_MOCK=false
LLM_PROVIDER=anthropic
ANTHROPIC_API_BASE=https://api.anthropic.com/v1
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-model
```

Google Gemini mode:

```bash
LLM_MOCK=false
LLM_PROVIDER=gemini
GEMINI_API_BASE=https://generativelanguage.googleapis.com/v1beta
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.0-flash
```

Set the model name to the model available in your provider account or internal
gateway. API keys should stay in `.env` or server environment variables, not in
frontend code.
