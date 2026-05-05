import { useCallback, useEffect, useRef, useState } from "react";

// ── Config ────────────────────────────────────────────────────────────────────

const STORAGE_KEY = "th_config";

interface Config {
  url: string;       // TokenHouse base URL, e.g. http://localhost:8787
  apiKey: string;    // TokenHouse member API key
  model: string;
}

function loadConfig(): Config {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Config;
  } catch {}
  return {
    url: import.meta.env.VITE_TOKENHOUSE_URL ?? "http://localhost:8787",
    apiKey: import.meta.env.VITE_TOKENHOUSE_KEY ?? "",
    model: import.meta.env.VITE_TOKENHOUSE_MODEL ?? "claude-sonnet-4-6",
  };
}

function saveConfig(c: Config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

// ── Streaming ─────────────────────────────────────────────────────────────────

async function* streamChat(
  config: Config,
  messages: { role: string; content: string }[],
  sessionId: string,
  signal: AbortSignal
): AsyncGenerator<string> {
  const res = await fetch(`${config.url}/api/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: true,
      max_tokens: 8192,
      session_id: sessionId,
    }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") return;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {}
    }
  }
}

// ── Config panel ──────────────────────────────────────────────────────────────

function ConfigPanel({
  config,
  onChange,
  onClose,
}: {
  config: Config;
  onChange: (c: Config) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(config);

  const save = () => {
    saveConfig(draft);
    onChange(draft);
    onClose();
  };

  return (
    <div className="config-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="config-panel">
        <h2>Connection Settings</h2>
        <label>
          TokenHouse URL
          <input
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            placeholder="http://localhost:8787"
            spellCheck={false}
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            value={draft.apiKey}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            placeholder="th_..."
            spellCheck={false}
          />
        </label>
        <label>
          Model
          <input
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            placeholder="claude-sonnet-4-6"
            spellCheck={false}
          />
          <span className="field-hint">Any model ID your TokenHouse org has access to</span>
        </label>
        <div className="config-actions">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────────

function Bubble({ msg }: { msg: Message }) {
  return (
    <div className={`bubble bubble--${msg.role}`}>
      <div className="bubble-role">{msg.role === "user" ? "You" : "Claude"}</div>
      <div className="bubble-content">
        {msg.content || (msg.streaming ? <span className="cursor" /> : null)}
        {msg.streaming && msg.content && <span className="cursor" />}
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export function App() {
  const [config, setConfig] = useState<Config>(loadConfig);
  const [showConfig, setShowConfig] = useState(!loadConfig().apiKey);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId] = useState(() => crypto.randomUUID());

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    if (!config.apiKey) { setShowConfig(true); return; }

    setError(null);
    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: text };
    const asstId = crypto.randomUUID();
    const asstShell: Message = { id: asstId, role: "assistant", content: "", streaming: true };

    setMessages((m) => [...m, userMsg, asstShell]);
    setInput("");
    setLoading(true);

    const history = [...messages, userMsg].map(({ role, content }) => ({ role, content }));

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      let acc = "";
      for await (const delta of streamChat(config, history, sessionId, ctrl.signal)) {
        acc += delta;
        setMessages((m) =>
          m.map((msg) => (msg.id === asstId ? { ...msg, content: acc } : msg))
        );
      }
      setMessages((m) =>
        m.map((msg) => (msg.id === asstId ? { ...msg, streaming: false } : msg))
      );
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const err = e instanceof Error ? e.message : "Unknown error";
      setError(err);
      setMessages((m) =>
        m.map((msg) =>
          msg.id === asstId ? { ...msg, content: msg.content || `Error: ${err}`, streaming: false } : msg
        )
      );
    } finally {
      setLoading(false);
      abortRef.current = null;
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [input, loading, config, messages, sessionId]);

  const stop = () => {
    abortRef.current?.abort();
    setMessages((m) => m.map((msg) => msg.streaming ? { ...msg, streaming: false } : msg));
    setLoading(false);
  };

  const newChat = () => {
    window.location.reload();
  };

  const configured = Boolean(config.apiKey && config.url);

  return (
    <div className="layout">
      {showConfig && (
        <ConfigPanel
          config={config}
          onChange={setConfig}
          onClose={() => setShowConfig(false)}
        />
      )}

      <header className="header">
        <div className="header-left">
          <span className="logo">TokenHouse</span>
          <span className="model-badge">{config.model}</span>
        </div>
        <div className="header-right">
          <button className="btn-ghost btn-sm" onClick={newChat}>New chat</button>
          <button
            className={`btn-ghost btn-sm ${configured ? "" : "btn-warn"}`}
            onClick={() => setShowConfig(true)}
          >
            {configured ? "Settings" : "Connect"}
          </button>
        </div>
      </header>

      <main className="messages">
        {messages.length === 0 && (
          <div className="empty">
            <div className="empty-title">TokenHouse Chat</div>
            <div className="empty-sub">
              {configured
                ? `Connected to ${config.url}`
                : "Click Connect to set your TokenHouse URL and API key"}
            </div>
          </div>
        )}
        {messages.map((msg) => <Bubble key={msg.id} msg={msg} />)}
        {error && <div className="error-banner">{error}</div>}
        <div ref={bottomRef} />
      </main>

      <footer className="composer">
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
          placeholder="Message… (Shift+Enter for new line)"
          rows={3}
          disabled={loading}
        />
        {loading ? (
          <button className="btn-stop" onClick={stop}>Stop</button>
        ) : (
          <button className="btn-send" onClick={() => void send()} disabled={!input.trim() || !configured}>
            Send
          </button>
        )}
      </footer>
    </div>
  );
}
