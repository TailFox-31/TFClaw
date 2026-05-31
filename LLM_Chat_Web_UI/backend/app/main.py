from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware

from .config import save_env_values, settings, update_environment
from .db import connect, init_db, utc_now
from .llm import complete_chat, llm_status
from .schemas import (
    ChatRequest,
    ChatResponse,
    ConversationCreateRequest,
    DeviceCreateRequest,
    LlmConfigUpdateRequest,
    LoginRequest,
    LoginResponse,
    UserCreateRequest,
)
from .security import (
    assert_device_allowed,
    create_session,
    get_current_user,
    hash_password,
    require_admin,
    verify_password,
)


app = FastAPI(title="LLM Chat Web UI API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    init_db()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/llm/status")
def get_llm_status(user: dict = Depends(get_current_user)) -> dict:
    return llm_status()


@app.get("/api/admin/llm-config")
def get_llm_config(user: dict = Depends(get_current_user)) -> dict:
    require_admin(user)
    return {
        "provider": "mock" if settings.llm_mock else settings.llm_provider,
        "llm_api_base": settings.llm_api_base,
        "llm_model": settings.llm_model,
        "llm_api_key_set": bool(settings.llm_api_key),
        "anthropic_api_base": settings.anthropic_api_base,
        "anthropic_model": settings.anthropic_model,
        "anthropic_api_key_set": bool(settings.anthropic_api_key),
        "gemini_api_base": settings.gemini_api_base,
        "gemini_model": settings.gemini_model,
        "gemini_api_key_set": bool(settings.gemini_api_key),
    }


@app.post("/api/admin/llm-config")
def update_llm_config(
    payload: LlmConfigUpdateRequest,
    user: dict = Depends(get_current_user),
) -> dict:
    require_admin(user)

    provider = payload.provider.strip().lower()
    updates = {
        "LLM_MOCK": "true" if provider == "mock" else "false",
        "LLM_PROVIDER": "openai" if provider == "mock" else provider,
        "LLM_API_BASE": payload.llm_api_base.strip(),
        "LLM_MODEL": payload.llm_model.strip(),
        "ANTHROPIC_API_BASE": payload.anthropic_api_base.strip(),
        "ANTHROPIC_MODEL": payload.anthropic_model.strip(),
        "GEMINI_API_BASE": payload.gemini_api_base.strip(),
        "GEMINI_MODEL": payload.gemini_model.strip(),
    }
    if payload.llm_api_key:
        updates["LLM_API_KEY"] = payload.llm_api_key.strip()
    if payload.anthropic_api_key:
        updates["ANTHROPIC_API_KEY"] = payload.anthropic_api_key.strip()
    if payload.gemini_api_key:
        updates["GEMINI_API_KEY"] = payload.gemini_api_key.strip()

    save_env_values(updates)
    update_environment(updates)
    return llm_status()


@app.post("/api/auth/login", response_model=LoginResponse)
def login(payload: LoginRequest, request: Request) -> LoginResponse:
    assert_device_allowed(request)
    with connect() as conn:
        row = conn.execute(
            """
            SELECT id, username, password_hash, role, is_active
            FROM users
            WHERE username = ?
            """,
            (payload.username,),
        ).fetchone()

    if row is None or row["is_active"] != 1:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    if not verify_password(payload.password, row["password_hash"]):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

    token = create_session(row["id"])
    return LoginResponse(token=token, username=row["username"], role=row["role"])


@app.get("/api/auth/me")
def me(user: dict = Depends(get_current_user)) -> dict:
    return {"id": user["id"], "username": user["username"], "role": user["role"]}


@app.get("/api/conversations")
def list_conversations(user: dict = Depends(get_current_user)) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, title, created_at, updated_at
            FROM conversations
            WHERE user_id = ?
            ORDER BY updated_at DESC
            """,
            (user["id"],),
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/conversations")
def create_conversation(
    payload: ConversationCreateRequest,
    user: dict = Depends(get_current_user),
) -> dict:
    now = utc_now()
    with connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO conversations (user_id, title, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (user["id"], payload.title, now, now),
        )
    return {"id": cursor.lastrowid, "title": payload.title}


@app.get("/api/conversations/{conversation_id}/messages")
def list_messages(conversation_id: int, user: dict = Depends(get_current_user)) -> list[dict]:
    _assert_conversation_owner(conversation_id, user["id"])
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, role, content, created_at
            FROM messages
            WHERE conversation_id = ?
            ORDER BY id ASC
            """,
            (conversation_id,),
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/chat", response_model=ChatResponse)
def chat(payload: ChatRequest, user: dict = Depends(get_current_user)) -> ChatResponse:
    conversation_id = payload.conversation_id
    now = utc_now()
    if conversation_id is None:
        title = payload.message[:80] or "New chat"
        with connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO conversations (user_id, title, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (user["id"], title, now, now),
            )
            conversation_id = int(cursor.lastrowid)
    else:
        _assert_conversation_owner(conversation_id, user["id"])

    with connect() as conn:
        conn.execute(
            """
            INSERT INTO messages (conversation_id, role, content, created_at)
            VALUES (?, 'user', ?, ?)
            """,
            (conversation_id, payload.message, now),
        )
        rows = conn.execute(
            """
            SELECT role, content
            FROM messages
            WHERE conversation_id = ?
            ORDER BY id ASC
            """,
            (conversation_id,),
        ).fetchall()

    history = [{"role": row["role"], "content": row["content"]} for row in rows]
    answer = complete_chat(history)

    with connect() as conn:
        conn.execute(
            """
            INSERT INTO messages (conversation_id, role, content, created_at)
            VALUES (?, 'assistant', ?, ?)
            """,
            (conversation_id, answer, utc_now()),
        )
        conn.execute(
            """
            UPDATE conversations
            SET updated_at = ?
            WHERE id = ?
            """,
            (utc_now(), conversation_id),
        )

    return ChatResponse(conversation_id=conversation_id, answer=answer)


@app.get("/api/admin/devices")
def list_devices(user: dict = Depends(get_current_user)) -> list[dict]:
    require_admin(user)
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, label, cert_fingerprint, ip_cidr, is_enabled, created_at
            FROM devices
            ORDER BY id DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/admin/devices")
def create_device(
    payload: DeviceCreateRequest,
    user: dict = Depends(get_current_user),
) -> dict:
    require_admin(user)
    with connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO devices (label, cert_fingerprint, ip_cidr, is_enabled, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                payload.label,
                payload.cert_fingerprint,
                payload.ip_cidr,
                1 if payload.is_enabled else 0,
                utc_now(),
            ),
        )
    return {"id": cursor.lastrowid}


@app.post("/api/admin/users")
def create_user(
    payload: UserCreateRequest,
    user: dict = Depends(get_current_user),
) -> dict:
    require_admin(user)
    with connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO users (username, password_hash, role, is_active, created_at)
            VALUES (?, ?, ?, 1, ?)
            """,
            (payload.username, hash_password(payload.password), payload.role, utc_now()),
        )
    return {"id": cursor.lastrowid, "username": payload.username}


def _assert_conversation_owner(conversation_id: int, user_id: int) -> None:
    with connect() as conn:
        row = conn.execute(
            """
            SELECT id
            FROM conversations
            WHERE id = ? AND user_id = ?
            """,
            (conversation_id, user_id),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
