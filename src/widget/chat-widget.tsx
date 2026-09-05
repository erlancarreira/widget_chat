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
  /**
   * Sinal "visitante digitando" para um PAINEL DE ATENDENTE (POST /typing + broadcast).
   * "agent" (default) mantém o sinal — só faça sentido se ALGUÉM assina o canal;
   * "off" elimina as requisições (indicador local do visitante continua instantâneo).
   * Use "off" quando o atendimento humano acontece fora de uma UI web (ex.: WhatsApp).
   */
  typing?: "agent" | "off";
  /**
   * Exige consentimento LGPD explícito: renderiza um checkbox obrigatório no pré-chat
   * (desabilita o envio enquanto desmarcado; o servidor registra consentAt = now).
   * Default: false. O valor marcado viaja no POST e vira evidência persistida.
   */
  consentRequired?: boolean;
  /**
   * URL da política de privacidade linkada no checkbox (default: "/privacidade" —
   * página servida pelo site consumidor; abre em nova aba).
   */
  consentUrl?: string;
}

const DEFAULT_ACCENT = "#25D366";
/**
 * Pausa (ms) que encerra o "digitando…" — usado pelos DOIS indicadores que o visitante
 * vê (os próprios pontinhos, 100% locais, e o do atendente via realtime): pontinhos
 * sobrevivem a pausas curtas de pensamento, igual WhatsApp. Debounce também mantém o
 * sinal de rede econômico: `true` uma vez por rajada, `false` só após o silêncio.
 */
const TYPING_IDLE_MS = 4_000;
/**
 * Limite (ms) dos pontinhos "preparando resposta" após o envio do visitante: se a
 * resposta não renderizar até aqui (bot fora, n8n lento), os pontinhos param sozinhos
 * em vez de girar para sempre. Coberto normalmente pela resposta (realtime ou polling).
 */
const BOT_TYPING_MAX_MS = 10_000;

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

/** Skeleton de restauração: mostrado no lugar do pré-chat form enquanto o GET do
 *  histórico da sessão persistida está em voo — nunca "pedir os dados" de novo por
 *  causa de uma corrida de carregamento. */
function RestoringSkeleton({ tr }: { tr: (k: WidgetKey) => string }): ReactElement {
  return (
    <div className="ecw-skeleton" role="status" aria-busy="true" aria-label={tr("loading")}>
      <span className="ecw-sr-only">{tr("loading")}</span>
      <div className="ecw-skeleton-row">
        <div className="ecw-skel ecw-skel--owner" />
      </div>
      <div className="ecw-skeleton-row">
        <div className="ecw-skel ecw-skel--visitor" />
      </div>
      <div className="ecw-skeleton-row">
        <div className="ecw-skel ecw-skel--owner ecw-skel--short" />
      </div>
    </div>
  );
}

interface FormProps {
  welcome: string;
  tr: (k: WidgetKey) => string;
  error: string | null;
  sending: boolean;
  firstFieldRef: RefObject<HTMLInputElement>;
  /** Exige o checkbox de consentimento LGPD (default false). */
  consentRequired: boolean;
  /** URL da política de privacidade linkada no checkbox (default "/privacidade"). */
  consentUrl: string;
  onSubmit(values: { name: string; phone: string; message: string; honeypot: string; consent: boolean }): Promise<void>;
}

function PreChatForm({ welcome, tr, error, sending, firstFieldRef, consentRequired, consentUrl, onSubmit }: FormProps): ReactElement {
  const uid = useId();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [consent, setConsent] = useState(false);
  const [consentTouched, setConsentTouched] = useState(false);
  const [phoneTouched, setPhoneTouched] = useState(false);

  const phoneValid = isValidPhone(phone);
  const complete = name.trim() !== "" && phoneValid && message.trim() !== "" && (!consentRequired || consent);

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (!complete || sending) return;
    void onSubmit({ name, phone, message, honeypot, consent });
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

      {consentRequired && (
        <div className="ecw-field ecw-consent">
          <label className="ecw-consent-row" htmlFor={`${uid}-consent`}>
            <input
              id={`${uid}-consent`}
              type="checkbox"
              checked={consent}
              onChange={(e) => { setConsentTouched(true); setConsent(e.target.checked); }}
            />
            <span className="ecw-consent-text">
              {tr("consentLabel")}{" "}
              <a className="ecw-consent-link" href={consentUrl} target="_blank" rel="noopener noreferrer">
                {tr("privacyPolicy")}
              </a>
            </span>
          </label>
          {consentTouched && !consent && (
            <p className="ecw-error" role="alert">{tr("consentRequired")}</p>
          )}
        </div>
      )}

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
  // `true` só na TRANSIÇÃO para digitando (não a cada tecla) e `false` após
  // TYPING_IDLE_MS de inatividade, ao enviar ou ao perder o foco — no máximo 2 requests
  // por rajada de digitação. `onChange` já cobre keyup, cola e IME (mais robusto que keyup puro).
  const typingRef = useRef(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Indicador de digitação DO PRÓPRIO visitante: renderizado LOCALMENTE (sem round-trip
  // de rede) para ser instantâneo/fluido. Grandes apps (WhatsApp, Messenger, Slack) nunca
  // mostram o "digitando" do próprio usuário com latência — a outra ponta recebe pela rede
  // (latência cross-dispositivo aceitável), mas o próprio usuário tem feedback imediato.
  const selfTypingRef = useRef(false);
  const selfTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selfTyping, setSelfTyping] = useState(false);

  // Pontinhos "preparando resposta" (handoff): da saída da mensagem do visitante até a
  // resposta renderizar. Sem isso, os pontinhos cortam na hora que o input esvazia e
  // fica um buraco silencioso até a resposta chegar (o "typing" simulado da dona só
  // começa QUANDO a mensagem chega pelo canal).
  const [botTyping, setBotTyping] = useState(false);
  const botTypingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMessage = messages[messages.length - 1];

  useEffect(() => {
    return () => {
      if (typingTimer.current !== null) clearTimeout(typingTimer.current);
      if (selfTimer.current !== null) clearTimeout(selfTimer.current);
      if (botTypingTimer.current !== null) clearTimeout(botTypingTimer.current);
    };
  }, []);

  // Liga/desliga pela ÚLTIMA mensagem: visitor pending/sent → esperando resposta;
  // owner/system renderizada → resposta chegou, para. Enquanto o visitante digita a
  // próxima, os pontinhos dele assumem (mesmo visual, zero corte perceptível).
  useEffect(() => {
    if (!canCompose) return;
    const waiting =
      lastMessage !== undefined &&
      lastMessage.direction === "visitor" &&
      lastMessage.status !== "failed";
    if (waiting) {
      setBotTyping(true);
      if (botTypingTimer.current !== null) clearTimeout(botTypingTimer.current);
      botTypingTimer.current = setTimeout(() => setBotTyping(false), BOT_TYPING_MAX_MS);
    } else {
      setBotTyping(false);
    }
  }, [canCompose, lastMessage?.id, lastMessage?.status]);

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
    const value = e.target.value;
    setDraft(value);
    if (!canCompose) return;
    // REGRA: pontinhos só com caracteres no input. Apagou até ficar vazio → somem
    // NA HORA (local e rede), sem esperar o idle — sem "digitando" fantasma.
    if (value.trim() === "") {
      stopTypingSignal();
      stopSelfTyping();
      return;
    }
    // sinal para a OUTRA ponta (vai pela rede, com debounce/idle de 4s).
    if (!typingRef.current) {
      typingRef.current = true;
      void onTyping(true);
    }
    if (typingTimer.current !== null) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTypingSignal, TYPING_IDLE_MS);
    // indicador local do próprio visitante — instantâneo, sem esperar o servidor.
    if (!selfTypingRef.current) {
      selfTypingRef.current = true;
      setSelfTyping(true);
    }
    if (selfTimer.current !== null) clearTimeout(selfTimer.current);
    selfTimer.current = setTimeout(stopSelfTyping, TYPING_IDLE_MS);
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
        {/* Pontinhos "preparando resposta" (handoff pós-envio) — só quando ninguém
            mais está digitando, pra não duplicar o indicador. */}
        {botTyping && !ownerTyping && !selfTyping && canCompose && (
          <TypingIndicator from="owner" label={tr("typing")} />
        )}
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
  const { endpoint, locale, welcome, projectName, realtime, labels, typing, consentRequired, consentUrl } = props;
  const accentColor = props.accentColor ?? DEFAULT_ACCENT;

  const tr = useCallback((key: WidgetKey): string => t(locale, key, labels), [locale, labels]);
  const { state, closePanel, togglePanel, submitForm, sendMessage, retryMessage, startNewConversation, notifyTyping } =
    useChat({ endpoint, realtime });

  // "off" → nenhuma requisição de digitação sai do widget (o indicador LOCAL do
  // visitante continua instantâneo — é renderizado sem rede no ChatPanel).
  const noopTyping = useCallback(async (): Promise<void> => {}, []);
  const reportTyping = typing === "off" ? noopTyping : notifyTyping;

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
            <ChatPanel              messages={state.messages}
              canCompose={canCompose}
              sending={state.sending}
              locale={locale}
              tr={tr}
              listRef={listRef}
              firstFieldRef={firstFieldRef}
              ownerTyping={state.ownerTyping}
              visitorTyping={state.visitorTyping}
              onTyping={reportTyping}
              onSend={sendMessage}
              onRetry={retryMessage}
              onNewConversation={startNewConversation}
            />
          ) : state.restoring ? (
            // Sessão persistida em restauração: SKELETON em vez do form — sem pedir
            // os dados de novo por causa do flash de carregamento.
            <RestoringSkeleton tr={tr} />
          ) : (
            <PreChatForm
              welcome={welcome}
              tr={tr}
              error={state.error}
              sending={state.sending}
              firstFieldRef={firstFieldRef}
              consentRequired={consentRequired ?? false}
              consentUrl={consentUrl ?? "/privacidade"}
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
