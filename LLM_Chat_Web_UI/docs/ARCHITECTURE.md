# Architecture

## Phase 1 Flow

```text
Employee browser
  -> reverse proxy / TLS termination
  -> FastAPI backend
  -> local database
  -> OpenAI-compatible LLM endpoint
```

The browser authenticates with username and password. Device trust is enforced
on the server through certificate fingerprint and/or IP CIDR checks.

## Why Not Browser MAC/HWID

Modern browsers do not expose MAC addresses, disk serials, TPM IDs, or other
hardware identifiers to Web pages. This is a privacy and security boundary.

If hardware identity is mandatory, use phase 2 local agent attestation or
network-layer controls.

## Data Model

- `users`: local accounts.
- `devices`: whitelisted certificate fingerprints or IP CIDRs.
- `sessions`: bearer sessions.
- `conversations`: chat sessions per user.
- `messages`: user and assistant messages.

## LLM Integration

The backend calls an OpenAI-compatible endpoint:

```text
POST {LLM_API_BASE}/chat/completions
```

Relevant environment variables:

```text
LLM_API_BASE=http://127.0.0.1:8001/v1
LLM_API_KEY=
LLM_MODEL=local-model
LLM_MOCK=true
```
