from __future__ import annotations

import json
from urllib.parse import quote, urlencode
from urllib import request
from urllib.error import HTTPError, URLError

from .config import settings


def complete_chat(messages: list[dict[str, str]]) -> str:
    provider = current_provider()
    if provider == "mock":
        last_user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        return (
            "로컬 데모 응답입니다. 현재는 폐쇄망 LLM 대신 mock 모드로 동작합니다.\n\n"
            f"질문: {last_user}\n\n"
            "실제 LLM 서버 또는 임시 외부 API가 준비되면 LLM_MOCK=false, "
            "LLM_PROVIDER 값을 바꿔 같은 Web UI에서 연결할 수 있습니다."
        )
    if provider == "anthropic":
        return _complete_anthropic(messages)
    if provider == "gemini":
        return _complete_gemini(messages)
    if provider == "openai":
        return _complete_openai(messages)
    raise ValueError(f"unsupported LLM_PROVIDER: {provider}")


def current_provider() -> str:
    if settings.llm_mock:
        return "mock"
    return settings.llm_provider


def llm_status() -> dict[str, str | bool]:
    provider = current_provider()
    model = "mock"
    if provider == "openai":
        model = settings.llm_model
    elif provider == "anthropic":
        model = settings.anthropic_model
    elif provider == "gemini":
        model = settings.gemini_model
    return {
        "provider": provider,
        "model": model,
        "mock": provider == "mock",
        "label": f"{provider}: {model}",
    }


def _complete_openai(messages: list[dict[str, str]]) -> str:
    url = settings.llm_api_base.rstrip("/") + "/chat/completions"
    payload = json.dumps(
        {
            "model": settings.llm_model,
            "messages": messages,
            "temperature": 0.2,
        }
    ).encode()

    headers = {"Content-Type": "application/json"}
    if settings.llm_api_key:
        headers["Authorization"] = f"Bearer {settings.llm_api_key}"

    body = _post_json(url, payload, headers)
    return body["choices"][0]["message"]["content"]


def _complete_anthropic(messages: list[dict[str, str]]) -> str:
    url = settings.anthropic_api_base.rstrip("/") + "/messages"
    system_parts: list[str] = []
    chat_messages: list[dict[str, str]] = []
    for message in messages:
        role = message["role"]
        content = message["content"]
        if role == "system":
            system_parts.append(content)
            continue
        if role in {"user", "assistant"}:
            chat_messages.append({"role": role, "content": content})

    payload_dict = {
        "model": settings.anthropic_model,
        "max_tokens": 2048,
        "messages": chat_messages,
    }
    if system_parts:
        payload_dict["system"] = "\n\n".join(system_parts)

    payload = json.dumps(payload_dict).encode()
    headers = {
        "Content-Type": "application/json",
        "x-api-key": settings.anthropic_api_key,
        "anthropic-version": "2023-06-01",
    }
    body = _post_json(url, payload, headers)
    parts = body.get("content", [])
    return "".join(part.get("text", "") for part in parts if part.get("type") == "text")


def _complete_gemini(messages: list[dict[str, str]]) -> str:
    model = quote(settings.gemini_model, safe="")
    query = urlencode({"key": settings.gemini_api_key})
    url = settings.gemini_api_base.rstrip("/") + f"/models/{model}:generateContent?{query}"

    system_parts: list[str] = []
    contents: list[dict] = []
    for message in messages:
        role = message["role"]
        content = message["content"]
        if role == "system":
            system_parts.append(content)
            continue
        gemini_role = "model" if role == "assistant" else "user"
        contents.append({"role": gemini_role, "parts": [{"text": content}]})

    payload_dict: dict = {
        "contents": contents,
        "generationConfig": {"temperature": 0.2},
    }
    if system_parts:
        payload_dict["system_instruction"] = {
            "parts": [{"text": "\n\n".join(system_parts)}],
        }

    body = _post_json(
        url,
        json.dumps(payload_dict).encode(),
        {"Content-Type": "application/json"},
    )
    candidates = body.get("candidates") or []
    if not candidates:
        raise RuntimeError(f"Gemini returned no candidates: {body}")
    parts = candidates[0].get("content", {}).get("parts", [])
    text = "".join(part.get("text", "") for part in parts)
    if not text:
        raise RuntimeError(f"Gemini returned no text: {body}")
    return text


def _post_json(url: str, payload: bytes, headers: dict[str, str]) -> dict:
    req = request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with request.urlopen(req, timeout=120) as response:
            return json.loads(response.read().decode())
    except HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise RuntimeError(f"LLM HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"LLM connection failed: {exc.reason}") from exc
