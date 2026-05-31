from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.db import connect, init_db, utc_now
from app.security import hash_password


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: python scripts/create_admin.py <username> <password>")
        return 2

    username = sys.argv[1]
    password = sys.argv[2]
    init_db()
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO users (username, password_hash, role, is_active, created_at)
            VALUES (?, ?, 'admin', 1, ?)
            ON CONFLICT(username) DO UPDATE SET
                password_hash = excluded.password_hash,
                role = 'admin',
                is_active = 1
            """,
            (username, hash_password(password), utc_now()),
        )
    print(f"admin user ready: {username}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
