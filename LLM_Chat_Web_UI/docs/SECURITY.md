# Security Notes

## Recommended Phase 1 Access Control

Use all three layers where possible:

1. Network allowlist or internal-only routing.
2. mTLS at the reverse proxy.
3. Application login and device whitelist.

## Device Whitelist

Enable backend checks with:

```bash
export ENFORCE_DEVICE_WHITELIST=true
export TRUST_PROXY_HEADERS=true
export CLIENT_CERT_FINGERPRINT_HEADER=x-client-cert-fingerprint
```

The reverse proxy must only forward verified client certificate fingerprints.
Do not trust these headers directly from untrusted clients.

## Password Storage

The backend stores PBKDF2-SHA256 password hashes with per-user salts.

## Deployment Boundary

In a closed network, package dependencies should be mirrored internally and
checked into an approved artifact repository. Do not rely on public internet
package installation during production deployment.
