from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import ipaddress
import secrets
from typing import Any

from fastapi import Header, HTTPException, Request, status

from .config import settings
from .db import connect, utc_now


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000)
    return f"pbkdf2_sha256${salt}${digest.hex()}"


def verify_password(password: str, password_hash: str) -> bool:
    try:
        algorithm, salt, expected = password_hash.split("$", 2)
    except ValueError:
        return False
    if algorithm != "pbkdf2_sha256":
        return False
    actual = hash_password(password, salt).split("$", 2)[2]
    return hmac.compare_digest(actual, expected)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=settings.session_ttl_seconds
    )
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO sessions (user_id, token_hash, expires_at, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (user_id, hash_token(token), expires_at.isoformat(), utc_now()),
        )
    return token


def _parse_bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    return authorization.split(" ", 1)[1].strip()


def get_current_user(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    token = _parse_bearer(authorization)
    now = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        row = conn.execute(
            """
            SELECT users.*
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ?
              AND sessions.expires_at > ?
              AND users.is_active = 1
            """,
            (hash_token(token), now),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    return dict(row)


def require_admin(user: dict[str, Any]) -> None:
    if user.get("role") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)


def client_context(request: Request) -> tuple[str, str | None]:
    client_ip = request.client.host if request.client else ""
    if settings.trust_proxy_headers:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            client_ip = forwarded.split(",", 1)[0].strip()

    fingerprint = request.headers.get(settings.client_cert_fingerprint_header)
    if fingerprint:
        fingerprint = fingerprint.strip().lower().replace(":", "")
    return client_ip, fingerprint


def _ip_matches(ip: str, cidr: str | None) -> bool:
    if not cidr:
        return False
    try:
        return ipaddress.ip_address(ip) in ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        return False


def assert_device_allowed(request: Request) -> None:
    if not settings.enforce_device_whitelist:
        return

    ip, fingerprint = client_context(request)
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT cert_fingerprint, ip_cidr
            FROM devices
            WHERE is_enabled = 1
            """
        ).fetchall()

    for row in rows:
        stored_fp = row["cert_fingerprint"]
        stored_fp = stored_fp.lower().replace(":", "") if stored_fp else None
        if fingerprint and stored_fp and hmac.compare_digest(fingerprint, stored_fp):
            return
        if _ip_matches(ip, row["ip_cidr"]):
            return

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="device is not whitelisted",
    )
