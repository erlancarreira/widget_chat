// src/widget/chat-widget.tsx — ChatWidget: balão flutuante + painel de conversa.
//
// Sem Tailwind / lib de UI: toda a aparência vem de `injectWidgetStyles()` (classes
// `.ecw-*`), e o único estilo inline é a CSS var `--ecw-accent` (cor do tema). O estado
// inteiro vive em `use-chat.ts` (reducer + rede + realtime); aqui só render e foco.
//
// Acessibilidade (contrato da spec §2):
//  - balão: <button> com aria-label (i18n), aria-expanded e aria-haspopup="dialog";
//  - painel: role="dialog" aria-label="Chat"; foco no primeiro campo ao abrir;
//    ESC fecha e devolve o foco ao balão; clique fora NÃO fecha (mobile-friendly);
//  - todo input tem <label htmlFor> (useId → múltiplas instâncias sem colisão);
//  - badge de não lidas refletido no nome acessível do balão;
//  - sessão closed/failed: composer desabilitado, aviso em role="status" e botão real
//    "nova conversa" (o beco sem saída tem saída acessível por teclado);
//  - prefers-reduced-motion desliga animações (via CSS).

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
  type RefObject,
} from "react";
import type { RealtimeHandle } from "../bridge/types";
import type { ChatMessage } from "../types";
import { t, type WidgetKey, type WidgetLocale } from "./i18n";
import { injectWidgetStyles } from "./styles";
import { isValidPhone, maskPhone, useChat } from "./use-chat";

export type { WidgetLocale };

export interface ChatWidgetProps {
  /** Caminho da rota de chat (GET histórico / POST start+send), ex.: "/api/chat". */
  endpoint: string;
  locale: WidgetLocale;
  /** Saudação exibida no pré-chat form. */
  welcome: string;
  projectName: string;
  /** Cor de tema; default "#25D366". */
  accentColor?: string;
  /** Porta do widget (DI — Strategy): subscribe/unsubscribe do canal da sessão. */
  realtime: RealtimeHandle;
  /** Override pontual de copy por chave i18n. */
  labels?: Partial<Record<string, string>>;
}

const DEFAULT_ACCENT = "#25D366";

function ChatIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5c-1.5 0-2.9-.36-4.13-1L3 20l1.1-3.85A8.36 8.36 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
    </svg>
  );
}

function SendIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7z" />
    </svg>
  );
}

function formatTime(iso: string, locale: WidgetLocale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function StatusMark({ status }: { status: ChatMessage["status"] }): ReactElement {
  // ✓ = aceita pelo servidor (pending), ✓✓ = enviada, ⚠ = falhou.
  // Decorativo por design: o conjunto de chaves i18n é fixo (15) e o estado "failed" já
  // é anunciado de forma acessível pelo botão visível `retry` ao lado — um texto sr-only
  // reaproveitando "send"/"sending" soaria a ruído para quem usa leitor de tela.
  const glyph = status === "pending" ? "✓" : status === "sent" ? "✓✓" : "⚠";
  return (
    <span className={status === "failed" ? "ecw-status ecw-status--failed" : "ecw-status"} aria-hidden="true">
      {glyph}
    </span>
  );
}

/** "3 pontinhos" de digitação: bolha com três pontos animados + rótulo acessível.
 *  `from` alinha o indicador ao lado de quem representa (owner→esquerda, visitor→direita). */
function TypingIndicator({ from, label }: { from: "owner" | "visitor"; label: string }): ReactElement {
  return (
    <li className={`ecw-item ecw-item--${from}`} aria-live="polite">
      <div className="ecw-typing" role="status" aria-label={label}>
        <span className="ecw-typing-dot" />
        <span className="ecw-typing-dot" />
        <span className="ecw-typing-dot" />
        <span className="ecw-sr-only">{label}</span>
      </div>
    </li>
  );
}

interface FormProps {
  welcome: string;
  tr: (k: WidgetKey) => string;
  error: string | null;
  sending: boolean;
  firstFieldRef: RefObject<HTMLInputElement>;
  onSubmit(values: { name: string; phone: string; message: string; honeypot: string }): Promise<void>;
}

function PreChatForm({ welcome, tr, error, sending, firstFieldRef, onSubmit }: FormProps): ReactElement {
  const uid = useId();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [phoneTouched, setPhoneTouched] = useState(false);

  const phoneValid = isValidPhone(phone);
  const complete = name.trim() !== "" && phoneValid && message.trim() !== "";

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (!complete || sending) return;
    void onSubmit({ name, phone, message, honeypot });
  };

  return (
    <form className="ecw-form" onSubmit={handleSubmit} noValidate>
      <p className="ecw-welcome">{welcome}</p>
      <p className="ecw-notice">{tr("welcomeNotice")}</p>

      <div className="ecw-field">
        <label className="ecw-label" htmlFor={`${uid}-name`}>{tr("name")}</label>
        <input
          id={`${uid}-name`}
          ref={firstFieldRef}
          className="ecw-input"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => { setName(e.target.value); }}
          required
        />
      </div>

      <div className="ecw-field">
        <label className="ecw-label" htmlFor={`${uid}-phone`}>{tr("phone")}</label>
        <input
          id={`${uid}-phone`}
          className="ecw-input"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="(11) 99999-8888"
          value={phone}
          onChange={(e) => { setPhone(maskPhone(e.target.value)); }}
          onBlur={() => { setPhoneTouched(true); }}
          aria-invalid={phoneTouched && !phoneValid ? true : undefined}
          aria-describedby={phoneTouched && !phoneValid ? `${uid}-phone-err` : undefined}
          required
        />
        {phoneTouched && !phoneValid && (
          <p className="ecw-error" id={`${uid}-phone-err`} role="alert">{tr("invalidPhone")}</p>
        )}
      </div>

      <div className="ecw-field">
        <label className="ecw-label" htmlFor={`${uid}-message`}>{tr("message")}</label>
        <textarea
          id={`${uid}-message`}
          className="ecw-input"
          rows={3}
          autoComplete="off"
          value={message}
          onChange={(e) => { setMessage(e.target.value); }}
          required
        />
      </div>

      {/* Honeypot anti-bot: invisível para humanos (display:none via .ecw-hp),
          fora da ordem de tabulação e escondido do leitor de tela. */}
      <div className="ecw-hp" aria-hidden="true">
        <label htmlFor={`${uid}-website`}>Website</label>
        <input
          id={`${uid}-website`}
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(e) => { setHoneypot(e.target.value); }}
        />
      </div>

      {error === "sendError" && (
        <p className="ecw-error" role="alert">{tr("sendError")}</p>
      )}

      <button className="ecw-submit" type="submit" disabled={!complete || sending}>
        {sending ? tr("sending") : tr("send")}
      </button>
      <p className="ecw-notice">{tr("privacyNote")}</p>
    </form>
  );
}

interface ChatPanelProps {
  messages: ChatMessage[];
  /** Só `status === "active"` compõe; closed/failed mostram aviso + "nova conversa". */
  canCompose: boolean;
  sending: boolean;
  locale: WidgetLocale;
  tr: (k: WidgetKey) => string;
  listRef: RefObject<HTMLUListElement>;
  firstFieldRef: RefObject<HTMLInputElement>;
  /** True enquanto a dona da plataforma (atendente) digita → mostra os "3 pontinhos". */
  ownerTyping: boolean;
  /** True enquanto o VISITANTE (esta ponta) digita → "3 pontinhos" do lado do visitante. */
  visitorTyping: boolean;
  /** Avisa o servidor que o visitante está/parou de digitar. Best-effort. */
  onTyping(isTyping: boolean): Promise<void>;
  onSend(text: string): Promise<void>;
  onRetry(id: string): Promise<void>;
  onNewConversation(): void;
}

function ChatPanel({ messages, canCompose, sending, locale, tr, listRef, firstFieldRef, ownerTyping, onTyping, onSend, onRetry, onNewConversation }: ChatPanelProps): ReactElement {
  const uid = useId();
  const [draft, setDraft] = useState("");

  // Sinal "visitante digitando" para a OUTRA ponta (painel de atendente): dispara
  // `true` só na TRANSIÇÃO para digitando (não a cada tecla) e `false` após 2,5s de
  // inatividade, ao enviar ou ao perder o foco — evita um POST por caractere. `onChange`
  // já cobre keyup, cola e IME (mais robusto que keyup puro).
  const typingRef = useRef(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Indicador de digitação DO PRÓPRIO visitante: renderizado LOCALMENTE (sem round-trip
  // de rede) para ser instantâneo/fluido. Grandes apps (WhatsApp, Messenger, Slack) nunca
  // mostram o "digitando" do próprio usuário com latência — a outra ponta recebe pela rede
  // (latência cross-dispositivo aceitável), mas o próprio usuário tem feedback imediato.
  const selfTypingRef = useRef(false);
  const selfTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selfTyping, setSelfTyping] = useState(false);

  useEffect(() => {
    return () => {
      if (typingTimer.current !== null) clearTimeout(typingTimer.current);
      if (selfTimer.current !== null) clearTimeout(selfTimer.current);
    };
  }, []);

  const stopTypingSignal = useCallback((): void => {
    if (typingTimer.current !== null) {
      clearTimeout(typingTimer.current);
      typingTimer.current = null;
    }
    if (typingRef.current) {
      typingRef.current = false;
      void onTyping(false);
    }
  }, [onTyping]);

  const stopSelfTyping = useCallback((): void => {
    if (selfTimer.current !== null) {
      clearTimeout(selfTimer.current);
      selfTimer.current = null;
    }
    if (selfTypingRef.current) {
      selfTypingRef.current = false;
      setSelfTyping(false);
    }
  }, []);

  const handleDraftChange = (e: ChangeEvent<HTMLInputElement>): void => {
    setDraft(e.target.value);
    if (!canCompose) return;
    // sinal para a OUTRA ponta (vai pela rede, com debounce de 2,5s).
    if (!typingRef.current) {
      typingRef.current = true;
      void onTyping(true);
    }
    if (typingTimer.current !== null) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTypingSignal, 2500);
    // indicador local do próprio visitante — instantâneo, sem esperar o servidor.
    if (!selfTypingRef.current) {
      selfTypingRef.current = true;
      setSelfTyping(true);
    }
    if (selfTimer.current !== null) clearTimeout(selfTimer.current);
    selfTimer.current = setTimeout(stopSelfTyping, 2500);
  };

  const handleDraftBlur = (): void => {
    stopTypingSignal();
    stopSelfTyping();
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const text = draft.trim();
    if (text === "" || !canCompose) return;
    stopTypingSignal();
    stopSelfTyping();
    setDraft("");
    void onSend(text);
  };

  return (
    <>
      <ul ref={listRef} className="ecw-list">
        {messages.map((m) =>
          m.direction === "system" ? (
            <li key={m.id} className="ecw-item ecw-item--system" role="status">
              <div className="ecw-system">{m.body}</div>
            </li>
          ) : (
            <li key={m.id} className={`ecw-item ecw-item--${m.direction}`}>
              <div className={`ecw-bubble ecw-bubble--${m.direction}`}>{m.body}</div>
              <div className="ecw-meta">
                <time dateTime={m.createdAt}>{formatTime(m.createdAt, locale)}</time>
                {m.direction === "visitor" && <StatusMark status={m.status} />}
                {m.status === "failed" && (
                  <button type="button" className="ecw-retry" onClick={() => { void onRetry(m.id); }}>
                    {tr("retry")}
                  </button>
                )}
              </div>
            </li>
          ),
        )}
        {ownerTyping && canCompose && <TypingIndicator from="owner" label={tr("typing")} />}
        {selfTyping && canCompose && <TypingIndicator from="visitor" label={tr("typing")} />}
      </ul>
      {!canCompose && (
        <div className="ecw-closed">
          <p className="ecw-notice" role="status">{tr("sessionClosed")}</p>
          <button type="button" className="ecw-submit" onClick={onNewConversation}>
            {tr("newConversation")}
          </button>
        </div>
      )}
      <form className="ecw-composer" onSubmit={submit}>
        <label className="ecw-sr-only" htmlFor={`${uid}-input`}>{tr("message")}</label>
        <input
          id={`${uid}-input`}
          ref={firstFieldRef}
          className="ecw-input"
          type="text"
          autoComplete="off"
          placeholder={tr("message")}
          value={draft}
          onChange={handleDraftChange}
          onBlur={handleDraftBlur}
          disabled={!canCompose}
        />
        <button className="ecw-send" type="submit" disabled={!canCompose || draft.trim() === "" || sending} aria-label={sending ? tr("sending") : tr("send")}>
          {sending ? (
            <>
              <span className="ecw-spinner" aria-hidden="true" />
              <span className="ecw-sr-only">{tr("sending")}</span>
            </>
          ) : (
            <SendIcon />
          )}
        </button>
      </form>
    </>
  );
}

export function ChatWidget(props: ChatWidgetProps): ReactElement {
  const { endpoint, locale, welcome, projectName, realtime, labels } = props;
  const accentColor = props.accentColor ?? DEFAULT_ACCENT;

  const tr = useCallback((key: WidgetKey): string => t(locale, key, labels), [locale, labels]);
  const { state, closePanel, togglePanel, submitForm, sendMessage, retryMessage, startNewConversation, notifyTyping } =
    useChat({ endpoint, realtime });

  const bubbleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    injectWidgetStyles();
  }, []);

  // Foco no primeiro campo ao abrir (form ou composer).
  useEffect(() => {
    if (state.open) firstFieldRef.current?.focus();
  }, [state.open, state.phase]);

  // ESC fecha o painel e devolve o foco ao balão.
  useEffect(() => {
    if (!state.open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      closePanel();
      bubbleRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [state.open, closePanel]);

  // Auto-scroll para a mensagem mais recente (ou os "3 pontinhos" de digitação).
  useEffect(() => {
    const list = listRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [state.messages, state.ownerTyping, state.visitorTyping, state.open]);

  const handleClose = useCallback((): void => {
    closePanel();
    bubbleRef.current?.focus();
  }, [closePanel]);

  // Só uma sessão "active" aceita mensagem; "closed"/"failed" mostram o aviso com a ação
  // de nova conversa (que limpa o storage e devolve o visitante ao pré-chat form).
  const canCompose = state.session?.status === "active";

  const bubbleLabel = state.unread > 0 ? `${tr("openChat")} (${state.unread})` : tr("openChat");

  return (
    <div className="ecw-root" style={{ "--ecw-accent": accentColor } as CSSProperties}>
      <button
        ref={bubbleRef}
        type="button"
        className="ecw-button"
        aria-label={bubbleLabel}
        aria-expanded={state.open}
        aria-haspopup="dialog"
        onClick={togglePanel}
      >
        <ChatIcon />
        {state.unread > 0 && <span className="ecw-badge">{state.unread}</span>}
      </button>

      {state.open && (
        <section className="ecw-panel" role="dialog" aria-label="Chat">
          <header className="ecw-header">
            <span className="ecw-title">{projectName}</span>
            {state.session !== null && <span className="ecw-code">#{state.session.code}</span>}
            <button type="button" className="ecw-close" aria-label={tr("close")} onClick={handleClose}>
              <span aria-hidden="true">×</span>
            </button>
          </header>

          {state.phase === "chat" ? (
            <ChatPanel
              messages={state.messages}
              canCompose={canCompose}
              sending={state.sending}
              locale={locale}
              tr={tr}
              listRef={listRef}
              firstFieldRef={firstFieldRef}
              ownerTyping={state.ownerTyping}
              visitorTyping={state.visitorTyping}
              onTyping={notifyTyping}
              onSend={sendMessage}
              onRetry={retryMessage}
              onNewConversation={startNewConversation}
            />
          ) : (
            <PreChatForm
              welcome={welcome}
              tr={tr}
              error={state.error}
              sending={state.sending}
              firstFieldRef={firstFieldRef}
              onSubmit={submitForm}
            />
          )}

          <footer className="ecw-footer">
            {tr("poweredBy")}{" "}
            <a
              className="ecw-powered-link"
              href="https://erlancarreira.com.br"
              target="_blank"
              rel="noopener noreferrer"
            >
              Erlan Carreira
            </a>
          </footer>
        </section>
      )}
    </div>
  );
}
