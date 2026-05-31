# Phase 2 Device Agent

The first release intentionally avoids browser-side MAC or hardware-ID checks
because normal Web browsers do not expose those values.

The second phase can add a local agent installed on approved workstations.

## Agent Responsibilities

- Collect approved identifiers such as MAC address, machine ID, disk serial, or
  TPM-backed identity.
- Sign or hash collected values before submitting them.
- Request a short-lived device token from the backend.
- Expose the token to the browser through a local loopback endpoint or a native
  helper flow approved by the security team.

## Backend Contract Draft

```http
POST /api/device-attestations
Content-Type: application/json

{
  "device_id": "site-defined-device-id",
  "agent_version": "0.1.0",
  "nonce": "server-issued-nonce",
  "evidence": {
    "mac_hashes": ["..."],
    "machine_id_hash": "...",
    "tpm_quote": "..."
  }
}
```

The backend should validate the evidence and issue a short-lived token that is
bound to the logged-in user and device.
