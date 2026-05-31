from dataclasses import dataclass, fields
import os
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT_DIR / ".env"


def _load_env_file(path: Path, *, override: bool = False) -> None:
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if override:
            os.environ[key] = value
        else:
            os.environ.setdefault(key, value)


_load_env_file(ENV_FILE)
_load_env_file(ROOT_DIR / "backend" / ".env")


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _csv_env(name: str, default: str) -> tuple[str, ...]:
    value = os.getenv(name, default)
    return tuple(item.strip() for item in value.split(",") if item.strip())


@dataclass
class Settings:
    database_path: str
    session_ttl_seconds: int
    enforce_device_whitelist: bool
    trust_proxy_headers: bool
    client_cert_fingerprint_header: str
    cors_origins: tuple[str, ...]
    llm_api_base: str
    llm_api_key: str
    llm_model: str
    llm_mock: bool
    llm_provider: str
    anthropic_api_base: str
    anthropic_api_key: str
    anthropic_model: str
    gemini_api_base: str
    gemini_api_key: str
    gemini_model: str


def load_settings() -> Settings:
    return Settings(
        database_path=os.getenv("DATABASE_PATH", "./llm_chat_web_ui.sqlite3"),
        session_ttl_seconds=int(os.getenv("SESSION_TTL_SECONDS", "28800")),
        enforce_device_whitelist=_bool_env("ENFORCE_DEVICE_WHITELIST", False),
        trust_proxy_headers=_bool_env("TRUST_PROXY_HEADERS", False),
        client_cert_fingerprint_header=os.getenv(
            "CLIENT_CERT_FINGERPRINT_HEADER",
            "x-client-cert-fingerprint",
        ),
        cors_origins=_csv_env(
            "CORS_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173",
        ),
        llm_api_base=os.getenv("LLM_API_BASE", "http://127.0.0.1:8001/v1"),
        llm_api_key=os.getenv("LLM_API_KEY", ""),
        llm_model=os.getenv("LLM_MODEL", "local-model"),
        llm_mock=_bool_env("LLM_MOCK", True),
        llm_provider=os.getenv("LLM_PROVIDER", "openai").strip().lower(),
        anthropic_api_base=os.getenv("ANTHROPIC_API_BASE", "https://api.anthropic.com/v1"),
        anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", ""),
        anthropic_model=os.getenv("ANTHROPIC_MODEL", "claude-model"),
        gemini_api_base=os.getenv(
            "GEMINI_API_BASE",
            "https://generativelanguage.googleapis.com/v1beta",
        ),
        gemini_api_key=os.getenv("GEMINI_API_KEY", ""),
        gemini_model=os.getenv("GEMINI_MODEL", "gemini-2.0-flash"),
    )


settings = load_settings()


def update_environment(updates: dict[str, str]) -> Settings:
    for key, value in updates.items():
        os.environ[key] = value
    fresh = load_settings()
    for field in fields(settings):
        setattr(settings, field.name, getattr(fresh, field.name))
    return settings


def save_env_values(updates: dict[str, str]) -> None:
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines() if ENV_FILE.is_file() else []
    next_lines: list[str] = []
    seen: set[str] = set()

    for raw_line in lines:
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#") or "=" not in raw_line:
            next_lines.append(raw_line)
            continue

        key = raw_line.split("=", 1)[0].strip()
        if key in updates:
            next_lines.append(f"{key}={updates[key]}")
            seen.add(key)
        else:
            next_lines.append(raw_line)

    for key, value in updates.items():
        if key not in seen:
            next_lines.append(f"{key}={value}")

    ENV_FILE.write_text("\n".join(next_lines).rstrip() + "\n", encoding="utf-8")
