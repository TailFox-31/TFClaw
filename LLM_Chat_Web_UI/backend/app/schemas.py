from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)


class LoginResponse(BaseModel):
    token: str
    username: str
    role: str


class UserCreateRequest(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=8)
    role: str = "user"


class DeviceCreateRequest(BaseModel):
    label: str = Field(min_length=1)
    cert_fingerprint: str | None = None
    ip_cidr: str | None = None
    is_enabled: bool = True


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    conversation_id: int | None = None


class ChatResponse(BaseModel):
    conversation_id: int
    answer: str


class ConversationCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=120)


class LlmConfigUpdateRequest(BaseModel):
    provider: str = Field(pattern="^(mock|openai|anthropic|gemini)$")
    llm_api_base: str = ""
    llm_api_key: str = ""
    llm_model: str = "local-model"
    anthropic_api_base: str = "https://api.anthropic.com/v1"
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-model"
    gemini_api_base: str = "https://generativelanguage.googleapis.com/v1beta"
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.0-flash"
