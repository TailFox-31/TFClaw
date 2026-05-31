# Deployment Sketch

The Web UI is browser-based and is not tied to a client OS. Windows and Linux
clients can both access the same HTTP/HTTPS URL as long as network routing,
firewall rules, and TLS trust are configured.

## Backend

```bash
cd backend
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python scripts/create_admin.py admin 'ChangeMe123!'
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## Frontend

```bash
cd frontend
npm install
npm run build
```

Serve `frontend/dist` through the reverse proxy or a static file server.

For development access from another PC on the same LAN:

```bash
cd frontend
npm run dev:lan -- --port 5173
```

Then open:

```text
http://SERVER_IP:5173
```

In this development mode, `/api` is proxied by Vite to
`http://127.0.0.1:8000` on the server machine.

## Reverse Proxy Responsibilities

- Terminate TLS.
- Enforce mTLS if certificates are used.
- Forward only verified client certificate fingerprints.
- Proxy `/api` to the FastAPI backend.
- Serve frontend static assets.

Example fingerprint header:

```text
X-Client-Cert-Fingerprint: 012345abcdef...
```
