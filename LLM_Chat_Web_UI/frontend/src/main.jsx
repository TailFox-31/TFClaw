import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LogOut, MessageSquarePlus, Send, Settings } from "lucide-react";
import "./styles.css";

const defaultLlmConfig = {
  provider: "mock",
  llm_api_base: "https://api.openai.com/v1",
  llm_api_key: "",
  llm_model: "local-model",
  anthropic_api_base: "https://api.anthropic.com/v1",
  anthropic_api_key: "",
  anthropic_model: "claude-model",
  gemini_api_base: "https://generativelanguage.googleapis.com/v1beta",
  gemini_api_key: "",
  gemini_model: "gemini-2.0-flash"
};

const api = {
  token: localStorage.getItem("token") || "",
  async request(path, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {})
    };
    if (api.token) headers.Authorization = `Bearer ${api.token}`;
    const response = await fetch(path, { ...options, headers });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }
};

function Login({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      const data = await api.request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      api.token = data.token;
      localStorage.setItem("token", data.token);
      onLogin(data);
    } catch {
      setError("Login failed");
    }
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <p className="eyebrow">Local LLM console</p>
        <h1>LLM Chat Web UI</h1>
        <input
          autoFocus
          placeholder="사용자명"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <input
          placeholder="비밀번호"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error && <p className="error">{error}</p>}
        <button type="submit">로그인</button>
      </form>
    </main>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [llmStatus, setLlmStatus] = useState({ label: "mock: mock" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [llmConfig, setLlmConfig] = useState(defaultLlmConfig);
  const [settingsMessage, setSettingsMessage] = useState("");

  useEffect(() => {
    if (!api.token) return;
    bootstrap().catch(() => localStorage.removeItem("token"));
  }, []);

  async function bootstrap() {
    const data = await api.request("/api/auth/me");
    setUser(data);
    await Promise.all([loadConversations(), loadLlmStatus()]);
  }

  async function loadConversations() {
    const data = await api.request("/api/conversations");
    setConversations(data);
  }

  async function loadLlmStatus() {
    const data = await api.request("/api/llm/status");
    setLlmStatus(data);
  }

  async function openSettings() {
    setSettingsMessage("");
    const data = await api.request("/api/admin/llm-config");
    setLlmConfig({ ...defaultLlmConfig, ...data });
    setSettingsOpen(true);
  }

  function updateLlmConfig(name, value) {
    setLlmConfig((current) => ({ ...current, [name]: value }));
  }

  async function saveSettings(event) {
    event.preventDefault();
    setSettingsMessage("");
    const data = await api.request("/api/admin/llm-config", {
      method: "POST",
      body: JSON.stringify(llmConfig)
    });
    setLlmStatus(data);
    setSettingsMessage("저장 완료");
  }

  async function openConversation(id) {
    setConversationId(id);
    const data = await api.request(`/api/conversations/${id}/messages`);
    setMessages(data);
  }

  async function sendMessage(event) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    setBusy(true);
    setInput("");
    setMessages((items) => [...items, { role: "user", content: text }]);
    try {
      const data = await api.request("/api/chat", {
        method: "POST",
        body: JSON.stringify({ conversation_id: conversationId, message: text })
      });
      setConversationId(data.conversation_id);
      setMessages((items) => [...items, { role: "assistant", content: data.answer }]);
      await loadConversations();
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    api.token = "";
    localStorage.removeItem("token");
    setUser(null);
    setConversationId(null);
    setMessages([]);
    setConversations([]);
  }

  async function handleLogin(data) {
    setUser(data);
    await Promise.all([loadConversations(), loadLlmStatus()]);
  }

  if (!user) return <Login onLogin={handleLogin} />;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <strong>LLM Chat</strong>
            <span>History</span>
          </div>
          <button className="icon-button" onClick={logout} title="Logout">
            <LogOut size={18} />
          </button>
        </div>
        <button
          className={conversationId === null ? "conversation active" : "conversation"}
          onClick={() => {
            setConversationId(null);
            setMessages([]);
          }}
        >
          <MessageSquarePlus size={17} />
          <span>새 대화</span>
        </button>
        {conversations.map((item) => (
          <button
            key={item.id}
            className={conversationId === item.id ? "conversation active" : "conversation"}
            onClick={() => openConversation(item.id)}
          >
            {item.title}
          </button>
        ))}
      </aside>
      <section className="chat">
        <header className="chat-header">
          <div>
            <strong>LLM Chat Web UI</strong>
            <span>{user.username}</span>
          </div>
          <div className="header-actions">
            <span className="status-pill">{llmStatus.label}</span>
            {user.role === "admin" && (
              <button className="icon-button" onClick={openSettings} title="LLM settings">
                <Settings size={18} />
              </button>
            )}
          </div>
        </header>
        <div className="messages">
          {messages.length === 0 && !busy && (
            <section className="empty-state">
              <h2>질문을 입력하세요</h2>
              <p>현재는 로컬 mock 응답으로 동작하며, 이후 폐쇄망 LLM API로 그대로 교체할 수 있습니다.</p>
            </section>
          )}
          {messages.map((message, index) => (
            <article key={index} className={`message ${message.role}`}>
              <div>{message.content}</div>
            </article>
          ))}
          {busy && (
            <article className="message assistant">
              <div>답변 생성 중...</div>
            </article>
          )}
        </div>
        <form className="composer" onSubmit={sendMessage}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="내부 LLM에 질문..."
            rows={2}
          />
          <button type="submit" title="Send" disabled={busy}>
            <Send size={20} />
          </button>
        </form>
      </section>
      {settingsOpen && (
        <section className="modal-backdrop">
          <form className="settings-panel" onSubmit={saveSettings}>
            <header>
              <div>
                <strong>LLM API 설정</strong>
                <span>API 키는 서버 .env에 저장됩니다.</span>
              </div>
              <button type="button" className="icon-button" onClick={() => setSettingsOpen(false)}>
                ×
              </button>
            </header>

            <label>
              Provider
              <select
                value={llmConfig.provider}
                onChange={(event) => updateLlmConfig("provider", event.target.value)}
              >
                <option value="mock">Mock</option>
                <option value="gemini">Gemini</option>
                <option value="openai">OpenAI compatible</option>
                <option value="anthropic">Claude</option>
              </select>
            </label>

            {llmConfig.provider === "gemini" && (
              <>
                <label>
                  Gemini API base
                  <input
                    value={llmConfig.gemini_api_base}
                    onChange={(event) => updateLlmConfig("gemini_api_base", event.target.value)}
                  />
                </label>
                <label>
                  Gemini model
                  <input
                    value={llmConfig.gemini_model}
                    onChange={(event) => updateLlmConfig("gemini_model", event.target.value)}
                  />
                </label>
                <label>
                  Gemini API key
                  <input
                    autoComplete="off"
                    placeholder={llmConfig.gemini_api_key_set ? "기존 키 유지" : "API 키 입력"}
                    type="password"
                    value={llmConfig.gemini_api_key}
                    onChange={(event) => updateLlmConfig("gemini_api_key", event.target.value)}
                  />
                </label>
              </>
            )}

            {llmConfig.provider === "openai" && (
              <>
                <label>
                  API base
                  <input
                    value={llmConfig.llm_api_base}
                    onChange={(event) => updateLlmConfig("llm_api_base", event.target.value)}
                  />
                </label>
                <label>
                  Model
                  <input
                    value={llmConfig.llm_model}
                    onChange={(event) => updateLlmConfig("llm_model", event.target.value)}
                  />
                </label>
                <label>
                  API key
                  <input
                    autoComplete="off"
                    placeholder={llmConfig.llm_api_key_set ? "기존 키 유지" : "API 키 입력"}
                    type="password"
                    value={llmConfig.llm_api_key}
                    onChange={(event) => updateLlmConfig("llm_api_key", event.target.value)}
                  />
                </label>
              </>
            )}

            {llmConfig.provider === "anthropic" && (
              <>
                <label>
                  Claude API base
                  <input
                    value={llmConfig.anthropic_api_base}
                    onChange={(event) => updateLlmConfig("anthropic_api_base", event.target.value)}
                  />
                </label>
                <label>
                  Claude model
                  <input
                    value={llmConfig.anthropic_model}
                    onChange={(event) => updateLlmConfig("anthropic_model", event.target.value)}
                  />
                </label>
                <label>
                  Claude API key
                  <input
                    autoComplete="off"
                    placeholder={llmConfig.anthropic_api_key_set ? "기존 키 유지" : "API 키 입력"}
                    type="password"
                    value={llmConfig.anthropic_api_key}
                    onChange={(event) => updateLlmConfig("anthropic_api_key", event.target.value)}
                  />
                </label>
              </>
            )}

            {settingsMessage && <p className="success">{settingsMessage}</p>}
            <footer>
              <button type="button" onClick={() => setSettingsOpen(false)}>
                닫기
              </button>
              <button type="submit">저장</button>
            </footer>
          </form>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
