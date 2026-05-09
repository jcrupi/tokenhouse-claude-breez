import {
  Component,
  createContext,
  Suspense,
  use,
  useActionState,
  useCallback,
  useDeferredValue,
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
  type Ref,
} from "react";
import { preload, useFormStatus } from "react-dom";

import { invalidateGrapesCache, readGrapes } from "./grapesResource";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GrapeStream {
  name: string;
  text: string;
  done: boolean;
  error?: string;
  tools: Array<{ name: string; done: boolean }>;
}

interface Turn {
  id: string;
  role: "user" | "grapes";
  content: string;
  grapes: GrapeStream[];
  allDone: boolean;
  optimistic?: boolean;
}

type OptimisticChatPayload = { userId: string; turnId: string; text: string };

interface Config {
  model: string;
}

// ── Config context (React 19: `<Context value={…}>` as provider) ───────────────

interface AppConfig {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config>>;
}

const AppConfigContext = createContext<AppConfig | null>(null);

// ── SSE fan-out stream ────────────────────────────────────────────────────────

async function streamTask(
  message: string,
  model: string,
  signal: AbortSignal,
  onRoster: (names: string[]) => void,
  onEvent: (evt: { grape: string; event: string; [k: string]: unknown }) => void,
): Promise<void> {
  const params = new URLSearchParams({ message, model });
  const res = await fetch(`/api/task/stream?${params}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";

    for (const frame of frames) {
      const trimmed = frame.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      let dataLine = "";
      for (const line of trimmed.split("\n")) {
        if (line.startsWith("data: ")) dataLine = line.slice(6).trim();
      }
      if (!dataLine) continue;
      try {
        const evt = JSON.parse(dataLine) as { grape: string; event: string; [k: string]: unknown };
        if (evt.event === "roster") onRoster(evt.grapes as string[]);
        else onEvent(evt);
      } catch {
        /* ignore malformed chunk */
      }
    }
  }
}

// ── Resource hints (react-dom preload) ─────────────────────────────────────────

function useGrapeApiPreload(): void {
  useEffect(() => {
    preload("/api/grapes", { as: "fetch" });
  }, []);
}

// ── Grapes UI (Suspense + use()) ───────────────────────────────────────────────

class GrapesErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return this.props.fallback ?? (
        <span className="grape-roster-badge grape-roster-badge--muted">offline</span>
      );
    }
    return this.props.children;
  }
}

function GrapeRosterBadgeInner() {
  const grapes = use(readGrapes());
  if (grapes.length === 0) return null;
  return (
    <span className="grape-roster-badge">
      {grapes.length} grape{grapes.length !== 1 ? "s" : ""}
    </span>
  );
}

function GrapeRosterBadge() {
  return (
    <GrapesErrorBoundary>
      <Suspense fallback={<span className="grape-roster-badge grape-roster-badge--pulse">…</span>}>
        <GrapeRosterBadgeInner />
      </Suspense>
    </GrapesErrorBoundary>
  );
}

function EmptyStateInner() {
  const grapes = use(readGrapes());
  return (
    <div className="empty-sub">
      {grapes.length === 0
        ? "No grapes connected — add entries to grapes.json and run bun dev:server"
        : `Orchestrating ${grapes.length} grape${grapes.length !== 1 ? "s" : ""}: ${grapes.map((g) => g.name).join(", ")}`}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <div className="empty-title">TokenHouse</div>
      <GrapesErrorBoundary
        fallback={
          <div className="empty-sub">Could not load grapes — is the orchestrator running?</div>
        }
      >
        <Suspense fallback={<div className="empty-sub">Loading grapes…</div>}>
          <EmptyStateInner />
        </Suspense>
      </GrapesErrorBoundary>
    </div>
  );
}

// ── Form status + actions ─────────────────────────────────────────────────────

function ChatComposerActions({ draft, onStop }: { draft: string; onStop: () => void }) {
  const { pending } = useFormStatus();
  return pending ? (
    <button type="button" className="btn-stop" onClick={onStop}>
      Stop
    </button>
  ) : (
    <button type="submit" className="btn-send" disabled={!draft.trim()}>
      Send
    </button>
  );
}

function SettingsSaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </button>
  );
}

// ── Composer textarea (React 19: ref as a prop on a function component) ───────

function ComposerTextarea({
  ref,
  ...props
}: React.ComponentPropsWithoutRef<"textarea"> & { ref?: Ref<HTMLTextAreaElement | null> }) {
  return <textarea ref={ref} {...props} />;
}

// ── Grape panel ───────────────────────────────────────────────────────────────

function GrapePanel({ gs }: { gs: GrapeStream }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [gs.text]);

  return (
    <div
      className={`grape-panel ${gs.done ? "grape-panel--done" : ""} ${gs.error ? "grape-panel--error" : ""}`}
    >
      <div className="grape-panel-header">
        <span className="grape-badge">🍇 {gs.name}</span>
        {gs.tools.length > 0 && (
          <span className="grape-tools">
            {gs.tools.map((t, i) => (
              <span key={i} className={`tool-chip ${t.done ? "tool-chip--done" : ""}`}>
                {t.name}
              </span>
            ))}
          </span>
        )}
        {gs.done && !gs.error && <span className="grape-done-badge">✓</span>}
        {gs.error && <span className="grape-error-badge">✗</span>}
      </div>
      <div
        className="grape-panel-body"
        ref={(node) => {
          scrollRef.current = node;
          return () => {
            scrollRef.current = null;
          };
        }}
      >
        {gs.error ? (
          <span className="grape-error-text">{gs.error}</span>
        ) : (
          gs.text || <span className="grape-waiting">connecting…</span>
        )}
        {!gs.done && !gs.error && <span className="cursor" />}
      </div>
    </div>
  );
}

// ── Turn bubble ───────────────────────────────────────────────────────────────

function TurnBubble({ turn }: { turn: Turn }) {
  if (turn.role === "user") {
    return (
      <div
        className={`bubble bubble--user ${turn.optimistic ? "bubble--optimistic" : ""}`}
      >
        <div className="bubble-role">You</div>
        <div className="bubble-content">{turn.content}</div>
      </div>
    );
  }
  return (
    <div className={`bubble bubble--grapes ${turn.optimistic ? "bubble--optimistic" : ""}`}>
      <div className="bubble-role">Grapes {turn.allDone ? "· done" : "· running…"}</div>
      <div className="grape-grid">
        {turn.grapes.map((gs, i) => (
          <GrapePanel key={`${turn.id}-${gs.name}-${i}`} gs={gs} />
        ))}
      </div>
    </div>
  );
}

// ── Config panel (form Action + useActionState + useFormStatus) ───────────────

const STORAGE_KEY = "th_config_v2";

function loadConfig(): Config {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    /* ignore */
  }
  return { model: "claude-sonnet-4-6" };
}

function ConfigPanel({ onClose }: { onClose: () => void }) {
  const ctx = use(AppConfigContext);
  if (!ctx) throw new Error("ConfigPanel requires AppConfigContext");

  const [saveError, saveAction] = useActionState(async (_prev: string | null, formData: FormData) => {
    const model = String(formData.get("model") ?? "").trim() || "claude-sonnet-4-6";
    try {
      const next = { model };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      ctx.setConfig(next);
      onClose();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, null);

  return (
    <div className="config-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="config-panel">
        <h2>Settings</h2>
        <form action={saveAction}>
          <label>
            Model
            <input
              name="model"
              defaultValue={ctx.config.model}
              placeholder="claude-sonnet-4-6"
              spellCheck={false}
            />
            <span className="field-hint">Passed to each grape — must be in its ALLOWED_MODELS list</span>
          </label>
          {saveError && <p className="config-error">{saveError}</p>}
          <div className="config-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <SettingsSaveButton />
          </div>
        </form>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export function App() {
  useGrapeApiPreload();

  const [, startScrollTransition] = useTransition();

  const [config, setConfig] = useState<Config>(loadConfig);
  const [showConfig, setShowConfig] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");

  const deferredModel = useDeferredValue(config.model, "claude-sonnet-4-6");

  const configRef = useRef(config);
  configRef.current = config;

  const [optimisticTurns, addOptimistic] = useOptimistic(
    turns,
    (state, pending: OptimisticChatPayload): Turn[] => [
      ...state,
      {
        id: pending.userId,
        role: "user",
        content: pending.text,
        grapes: [],
        allDone: false,
        optimistic: true,
      },
      {
        id: pending.turnId,
        role: "grapes",
        content: "",
        grapes: [
          { name: "…", text: "Connecting to grapes…", done: false, tools: [] },
        ],
        allDone: false,
        optimistic: true,
      },
    ],
  );

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [chatError, chatAction, isChatPending] = useActionState(async (_prev: string | null, formData: FormData) => {
    const text = String(formData.get("message") ?? "").trim();
    if (!text) return null;

    const userId = crypto.randomUUID();
    const turnId = crypto.randomUUID();

    addOptimistic({ userId, turnId, text });
    await Promise.resolve();

    const userTurn: Turn = {
      id: userId,
      role: "user",
      content: text,
      grapes: [],
      allDone: false,
    };
    const grapeTurn: Turn = {
      id: turnId,
      role: "grapes",
      content: "",
      grapes: [],
      allDone: false,
    };

    setTurns((t) => [...t, userTurn, grapeTurn]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const updateGrapeTurn = (fn: (t: Turn) => Turn) => {
      setTurns((all) => all.map((t) => (t.id === turnId ? fn(t) : t)));
    };

    try {
      await streamTask(
        text,
        configRef.current.model,
        ctrl.signal,
        (names) => {
          updateGrapeTurn((t) => ({
            ...t,
            grapes: names.map((name) => ({
              name,
              text: "",
              done: false,
              tools: [],
            })),
          }));
        },
        (evt) => {
          updateGrapeTurn((turn) => {
            const grapes = turn.grapes.map((gs) => {
              if (gs.name !== evt.grape) return gs;
              switch (evt.event) {
                case "chunk":
                  return { ...gs, text: gs.text + (evt.text as string ?? "") };
                case "tool_start":
                  return { ...gs, tools: [...gs.tools, { name: evt.tool as string, done: false }] };
                case "tool_result":
                  return {
                    ...gs,
                    tools: gs.tools.map((tl) =>
                      tl.name === evt.tool && !tl.done ? { ...tl, done: true } : tl,
                    ),
                  };
                case "done":
                  return {
                    ...gs,
                    text: gs.text || (evt.fullText as string ?? ""),
                    done: true,
                  };
                case "error":
                  return {
                    ...gs,
                    done: true,
                    error: evt.message as string ?? "Unknown error",
                  };
                default:
                  return gs;
              }
            });
            const allDone = grapes.length > 0 && grapes.every((gs) => gs.done);
            return { ...turn, grapes, allDone };
          });
        },
      );

      updateGrapeTurn((t) => ({
        ...t,
        allDone: true,
        grapes: t.grapes.map((gs) => (gs.done ? gs : { ...gs, done: true })),
      }));
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        updateGrapeTurn((t) => ({ ...t, allDone: true }));
        return null;
      }
      const msg = e instanceof Error ? e.message : String(e);
      updateGrapeTurn((t) => ({
        ...t,
        allDone: true,
        grapes:
          t.grapes.length > 0
            ? t.grapes.map((gs) => (gs.done ? gs : { ...gs, done: true, error: msg }))
            : [{ name: "orchestrator", text: "", done: true, error: msg, tools: [] }],
      }));
      return msg;
    } finally {
      abortRef.current = null;
      setDraft("");
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
    return null;
  }, null);

  useEffect(() => {
    startScrollTransition(() => {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }, [optimisticTurns, startScrollTransition]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setTurns((all) =>
      all.map((t) =>
        t.role === "grapes" && !t.allDone
          ? {
              ...t,
              allDone: true,
              grapes: t.grapes.map((gs) => (gs.done ? gs : { ...gs, done: true })),
            }
          : t,
      ),
    );
  }, []);

  const newChat = useCallback(() => {
    invalidateGrapesCache();
    window.location.reload();
  }, []);

  const onChatSubmit = (e: FormEvent<HTMLFormElement>) => {
    if (!draft.trim()) {
      e.preventDefault();
    }
  };

  return (
    <AppConfigContext value={{ config, setConfig }}>
      <>
        <title>TokenHouse Chat</title>
        <meta
          name="description"
          content="TokenHouse Breez — multi-grape orchestration chat powered by SSE and the orchestrator API."
        />

        <div className="layout">
          {showConfig && <ConfigPanel onClose={() => setShowConfig(false)} />}

          <header className="header">
            <div className="header-left">
              <span className="logo">🏠 TokenHouse</span>
              <span className="model-badge" title="Model sent to each grape">
                {deferredModel}
              </span>
              <GrapeRosterBadge />
            </div>
            <div className="header-right">
              <button type="button" className="btn-ghost btn-sm" onClick={newChat}>
                New chat
              </button>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setShowConfig(true)}>
                Settings
              </button>
            </div>
          </header>

          <main className="messages">
            {optimisticTurns.length === 0 && <EmptyState />}
            {optimisticTurns.map((t) => (
              <TurnBubble key={t.id} turn={t} />
            ))}
            {chatError && <div className="error-banner">{chatError}</div>}
            <div
              ref={(node) => {
                bottomRef.current = node;
                return () => {
                  bottomRef.current = null;
                };
              }}
            />
          </main>

          <footer className="composer">
            <form action={chatAction} onSubmit={onChatSubmit} className="composer-form">
              <ComposerTextarea
                ref={textareaRef}
                name="message"
                className="composer-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (isChatPending) return;
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Send a task to all grapes… (Shift+Enter for new line)"
                rows={3}
                readOnly={isChatPending}
              />
              <ChatComposerActions draft={draft} onStop={stop} />
            </form>
          </footer>
        </div>
      </>
    </AppConfigContext>
  );
}
