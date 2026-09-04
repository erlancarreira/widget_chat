// src/widget/use-chat.ts — máquina de estados do ChatWidget (hook puro, sem JSX).
//
// Fases: "idle" (painel nunca aberto, sem sessão) → "form" (pré-chat) → "chat" (sessão
// ativa). A transição idle→form acontece na primeira abertura; form→chat no POST bem
// sucedido; qualquer fase→form quando o GET devolve 404 (sessão expirada → storage limpo)
// ou quando o visitante pede "nova conversa" numa sessão closed/failed (`startNewConversation`).
//
// Tempo real (Strategy, invisível ao usuário): com token em mãos, `realtime.subscribe`
// anexa eventos; se o transporte cair (`onStatus("closed")`), o hook liga um POLLING de
// 5s no GET de histórico com `after=<última createdAt>` até o canal reabrir. Mensagens
// `owner` que chegam com o painel fechado somam no badge de não lidas.
//
// Otimismo: POST anexa uma mensagem `tmp-…` com status "pending"; a resposta do servidor
// SUBSTITUI o tmp (replace) — em falha, o tmp vira "failed" e ganha retry.

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ChatEvent, ChatMessage, ChatSessionStatus } from "../types";
import type { RealtimeHandle } from "../bridge/types";

/** Chave de persistência da sessão no localStorage. */
export const SESSION_STORAGE_KEY = "ecw:session";
/** Intervalo do fallback de polling quando o canal realtime fecha (ms). */
export const POLL_INTERVAL_MS = 5_000;
/** Mínimo de dígitos (com DDD) para um WhatsApp ser aceito no form. */
export const MIN_PHONE_DIGITS = 10;

export type ChatPhase = "idle" | "form" | "chat";

export interface SessionInfo {
  code: string;
  status: ChatSessionStatus;
  visitorName: string;
}

export interface ChatState {
  phase: ChatPhase;
  open: boolean;
  session: SessionInfo | null;
  token: string | null;
  messages: ChatMessage[];
  unread: number;
  sending: boolean;
  /** Chave i18n do erro visível ("sendError" | "invalidPhone") ou null. */
  error: string | null;
  /** True enquanto a DONA da plataforma (atendente) digita → "3 pontinhos" no widget. */
  ownerTyping: boolean;
  /** True enquanto o VISITANTE (esta ponta) digita — útil para um painel de atendente. */
  visitorTyping: boolean;
}

type Action =
  | { type: "open" }
  | { type: "close" }
  | { type: "restore"; session: SessionInfo; token: string; messages: ChatMessage[] }
  | { type: "start"; session: SessionInfo; token: string; messages: ChatMessage[] }
  | { type: "reset-form" }
  | { type: "append"; message: ChatMessage }
  | { type: "merge"; messages: ChatMessage[] }
  | { type: "replace"; tmpId: string; message: ChatMessage }
  | { type: "mark"; id: string; status: ChatMessage["status"] }
  | { type: "session-status"; status: ChatSessionStatus }
  | { type: "sending"; value: boolean }
  | { type: "error"; value: string | null }
  | { type: "typing"; from: "owner" | "visitor"; isTyping: boolean };

const initialState: ChatState = {
  phase: "idle",
  open: false,
  session: null,
  token: null,
  messages: [],
  unread: 0,
  sending: false,
  error: null,
  ownerTyping: false,
  visitorTyping: false,
};

function withMessage(state: ChatState, message: ChatMessage): ChatState {
  const index = state.messages.findIndex((m) => m.id === message.id);
  let messages: ChatMessage[];
  if (index >= 0) {
    messages = [...state.messages];
    messages[index] = message;
  } else {
    messages = [...state.messages, message];
  }
  const bump = state.open || message.direction !== "owner" ? 0 : 1;
  const next: ChatState = { ...state, messages, unread: state.unread + bump };
  // Quando chega uma mensagem da dona, ela parou de "digitar" (limpa os 3 pontinhos).
  if (message.direction === "owner") next.ownerTyping = false;
  return next;
}

export function chatReducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case "open":
      return {
        ...state,
        open: true,
        unread: 0,
        phase: state.phase === "idle" ? "form" : state.phase,
      };
    case "close":
      return { ...state, open: false };
    case "restore":
      return {
        ...state,
        phase: "chat",
        session: action.session,
        token: action.token,
        messages: action.messages,
      };
    case "start": {
      // O POST devolve o histórico oficial (inclui a 1ª msg do visitante); qualquer tmp
      // "pending" ainda não confirmado pelo servidor é mantido no fim da lista.
      let next: ChatState = {
        ...state,
        phase: "chat",
        session: action.session,
        token: action.token,
        messages: action.messages,
      };
      for (const pending of state.messages) {
        const confirmed = action.messages.some(
          (m) => m.direction === "visitor" && m.body === pending.body,
        );
        if (pending.status === "pending" && !confirmed) next = withMessage(next, pending);
      }
      return next;
    }
    case "reset-form":
      return { ...state, phase: "form", session: null, token: null, messages: [], unread: 0, error: null };
    case "append":
      return withMessage(state, action.message);
    case "merge": {
      let next = state;
      for (const message of action.messages) next = withMessage(next, message);
      return next;
    }
    case "replace": {
      const messages = state.messages.map((m) => (m.id === action.tmpId ? action.message : m));
      const kept = messages.some((m) => m.id === action.message.id);
      return { ...state, messages: kept ? messages : [...messages, action.message] };
    }
    case "mark":
      return {
        ...state,
        messages: state.messages.map((m) => (m.id === action.id ? { ...m, status: action.status } : m)),
      };
    case "session-status": {
      if (state.session === null) return state;
      return { ...state, session: { ...state.session, status: action.status } };
    }
    case "sending":
      return { ...state, sending: action.value };
    case "error":
      return { ...state, error: action.value };
    case "typing":
      // Só transiciona se mudar de fato (evita re-render a cada batida de presença).
      return action.from === "owner"
        ? state.ownerTyping === action.isTyping
          ? state
          : { ...state, ownerTyping: action.isTyping }
        : state.visitorTyping === action.isTyping
          ? state
          : { ...state, visitorTyping: action.isTyping };
  }
}

// ─── helpers de telefone ──────────────────────────────────────────────────────

/** Só dígitos (o servidor espera DDI+DDD+número sem máscara). */
export function normalizePhone(value: string): string {
  return value.replace(/\D/g, "");
}

/** Máscara BR parcial `(11) 99999-8888`, progressiva enquanto o usuário digita. */
export function maskPhone(value: string): string {
  const digits = normalizePhone(value).slice(0, 11);
  if (digits.length === 0) return "";
  const ddd = digits.slice(0, 2);
  if (digits.length <= 2) return `(${ddd}`;
  const rest = digits.slice(2);
  if (rest.length <= 5) return `(${ddd}) ${rest}`;
  return `(${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
}

export function isValidPhone(value: string): boolean {
  return normalizePhone(value).length >= MIN_PHONE_DIGITS;
}

// ─── persistência ─────────────────────────────────────────────────────────────

interface StoredSession {
  token: string;
  code: string;
}

function readStoredSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as StoredSession).token === "string" &&
      (parsed as StoredSession).token !== ""
    ) {
      const { token, code } = parsed as StoredSession;
      return { token, code: typeof code === "string" ? code : "" };
    }
    return null;
  } catch {
    return null;
  }
}

function writeStoredSession(session: StoredSession): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* storage cheio/bloqueado: sessão só não sobrevive ao reload */
  }
}

function clearStoredSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* idem */
  }
}

// ─── contrato de rede (espelha createChatRoutes — Task 8) ────────────────────

interface HistoryResponse {
  session?: SessionInfo;
  messages?: ChatMessage[];
}

interface StartResponse {
  session?: SessionInfo & { realtimeToken?: string };
  messages?: ChatMessage[];
}

interface SendResponse {
  message?: ChatMessage;
}

function historyUrl(endpoint: string, token: string, after: string | null): string {
  const params = new URLSearchParams({ token });
  if (after !== null) params.set("after", after);
  const sep = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${sep}${params.toString()}`;
}

function lastCursor(messages: ChatMessage[]): string | null {
  let latest: string | null = null;
  for (const m of messages) if (latest === null || m.createdAt > latest) latest = m.createdAt;
  return latest;
}

// ─── hook ─────────────────────────────────────────────────────────────────────

export interface UseChatOptions {
  endpoint: string;
  realtime: RealtimeHandle;
  /** Rota que recebe o sinal "visitante digitando" (POST { token, isTyping }). Default: `${endpoint}/typing`. */
  typingEndpoint?: string;
}

export interface UseChatResult {
  state: ChatState;
  openPanel(): void;
  closePanel(): void;
  togglePanel(): void;
  submitForm(input: { name: string; phone: string; message: string; honeypot: string }): Promise<void>;
  sendMessage(text: string): Promise<void>;
  retryMessage(id: string): Promise<void>;
  /** Descarta a sessão encerrada/falha (storage + estado) e volta ao pré-chat form. */
  startNewConversation(): void;
  /** Avisa o servidor que o visitante está (true) ou parou (false) de digitar. Best-effort. */
  notifyTyping(isTyping: boolean): Promise<void>;
}

let tmpSeq = 0;
function tmpMessage(body: string): ChatMessage {
  tmpSeq += 1;
  return {
    id: `tmp-${tmpSeq}`,
    sessionId: "",
    direction: "visitor",
    body,
    status: "pending",
    waMessageId: null,
    createdAt: new Date().toISOString(),
  };
}

export function useChat({ endpoint, realtime, typingEndpoint }: UseChatOptions): UseChatResult {
  const [state, dispatch] = useReducer(chatReducer, initialState);

  const typingUrl = typingEndpoint ?? `${endpoint.replace(/\/+$/, "")}/typing`;

  // Espelho do estado para callbacks estáveis (eventos realtime/poll chegam fora do React).
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // A porta pode chegar como objeto novo a cada render do consumidor; a assinatura deve
  // depender apenas do token, nunca da identidade do handle.
  const realtimeRef = useRef(realtime);
  useEffect(() => {
    realtimeRef.current = realtime;
  }, [realtime]);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback((): void => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const pollOnce = useCallback(async (): Promise<void> => {
    const { token, messages } = stateRef.current;
    if (token === null) return;
    try {
      const res = await fetch(historyUrl(endpoint, token, lastCursor(messages)), {
        method: "GET",
        headers: { accept: "application/json" },
      });
      if (res.status === 404) {
        clearStoredSession();
        stopPoll();
        dispatch({ type: "reset-form" });
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as HistoryResponse;
      if (Array.isArray(data.messages)) dispatch({ type: "merge", messages: data.messages });
      if (data.session !== undefined) dispatch({ type: "session-status", status: data.session.status });
    } catch {
      /* offline: o próximo tick tenta de novo */
    }
  }, [endpoint, stopPoll]);

  const startPoll = useCallback((): void => {
    if (pollRef.current !== null) return;
    pollRef.current = setInterval(() => {
      void pollOnce();
    }, POLL_INTERVAL_MS);
  }, [pollOnce]);

  // Abertura/fechamento do canal realtime (Strategy): caiu → polling; voltou → para.
  const handleStatus = useCallback(
    (s: "open" | "closed"): void => {
      if (s === "closed") startPoll();
      else stopPoll();
    },
    [startPoll, stopPoll],
  );

  const handleEvent = useCallback((e: ChatEvent): void => {
    if (e.type === "message" && e.message !== undefined) {
      dispatch({ type: "append", message: e.message });
    } else if (e.type === "session" && e.status !== undefined) {
      dispatch({ type: "session-status", status: e.status });
    } else if (e.type === "typing" && e.from !== undefined) {
      dispatch({ type: "typing", from: e.from, isTyping: e.isTyping });
    }
  }, []);

  // Boot: sessão persistida → GET de histórico (404 limpa o storage e volta ao form).
  useEffect(() => {
    const stored = readStoredSession();
    if (stored === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(historyUrl(endpoint, stored.token, null), {
          method: "GET",
          headers: { accept: "application/json" },
        });
        if (cancelled) return;
        if (res.status === 404) {
          clearStoredSession();
          dispatch({ type: "reset-form" });
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as HistoryResponse;
        if (cancelled || data.session === undefined) return;
        dispatch({
          type: "restore",
          session: data.session,
          token: stored.token,
          messages: Array.isArray(data.messages) ? data.messages : [],
        });
      } catch {
        /* sem rede: mantém o form/idle; o retry fica com o usuário */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  // Assinatura do canal enquanto houver token (re-assina quando a sessão muda).
  useEffect(() => {
    const token = state.token;
    if (token === null) return;
    const unsubscribe = realtimeRef.current.subscribe(token, handleEvent, handleStatus);
    return () => {
      unsubscribe();
      stopPoll();
    };
  }, [state.token, handleEvent, handleStatus, stopPoll]);

  useEffect(() => stopPoll, [stopPoll]);

  const openPanel = useCallback((): void => {
    dispatch({ type: "open" });
  }, []);

  const closePanel = useCallback((): void => {
    dispatch({ type: "close" });
  }, []);

  const togglePanel = useCallback((): void => {
    if (stateRef.current.open) dispatch({ type: "close" });
    else dispatch({ type: "open" });
  }, []);

  const postMessage = useCallback(
    async (token: string, body: string, id: string): Promise<void> => {
      dispatch({ type: "sending", value: true });
      dispatch({ type: "error", value: null });
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, message: body }),
        });
        if (!res.ok) {
          dispatch({ type: "mark", id, status: "failed" });
          dispatch({ type: "error", value: "sendError" });
          return;
        }
        const data = (await res.json()) as SendResponse;
        if (data.message !== undefined) dispatch({ type: "replace", tmpId: id, message: data.message });
        else dispatch({ type: "mark", id, status: "failed" });
      } catch {
        dispatch({ type: "mark", id, status: "failed" });
        dispatch({ type: "error", value: "sendError" });
      } finally {
        dispatch({ type: "sending", value: false });
      }
    },
    [endpoint],
  );

  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      const body = text.trim();
      const token = stateRef.current.token;
      if (body === "" || token === null) return;
      const optimistic = tmpMessage(body);
      dispatch({ type: "append", message: optimistic });
      await postMessage(token, body, optimistic.id);
    },
    [postMessage],
  );

  const retryMessage = useCallback(
    async (id: string): Promise<void> => {
      const token = stateRef.current.token;
      const target = stateRef.current.messages.find((m) => m.id === id);
      if (token === null || target === undefined || target.direction !== "visitor") return;
      dispatch({ type: "mark", id, status: "pending" });
      await postMessage(token, target.body, id);
    },
    [postMessage],
  );

  // Sessão closed/failed: o visitante resolve o beco sem saída pedindo uma conversa nova.
  // Limpa o storage (senão o próximo boot restauraria a mesma sessão morta) e volta ao
  // form; a assinatura realtime cai sozinha na limpeza do efeito, porque token → null.
  const startNewConversation = useCallback((): void => {
    clearStoredSession();
    dispatch({ type: "reset-form" });
  }, []);

  // Avisa o servidor que o visitante está (ou parou de) digitar. Best-effort: nunca
  // deve quebrar o fluxo de envio de mensagens — falhas são silenciadas.
  const notifyTyping = useCallback(
    async (isTyping: boolean): Promise<void> => {
      const token = stateRef.current.token;
      if (token === null) return;
      try {
        await fetch(typingUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, isTyping }),
        });
      } catch {
        /* offline/erro: digitação é cosmética, ignora */
      }
    },
    [typingUrl],
  );

  const submitForm = useCallback(
    async ({ name, phone, message, honeypot }: { name: string; phone: string; message: string; honeypot: string }): Promise<void> => {
      // Anti-bot silencioso: honeypot preenchido → nada sai do navegador (o servidor
      // também fingiria sucesso; aqui nem há request).
      if (honeypot.trim() !== "") return;
      const digits = normalizePhone(phone);
      if (name.trim() === "" || message.trim() === "" || digits.length < MIN_PHONE_DIGITS) {
        dispatch({ type: "error", value: digits.length < MIN_PHONE_DIGITS ? "invalidPhone" : "sendError" });
        return;
      }
      const optimistic = tmpMessage(message.trim());
      dispatch({ type: "append", message: optimistic });
      dispatch({ type: "sending", value: true });
      dispatch({ type: "error", value: null });
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name.trim(), phone: digits, message: message.trim(), honeypot: "" }),
        });
        if (!res.ok) {
          dispatch({ type: "mark", id: optimistic.id, status: "failed" });
          dispatch({ type: "error", value: "sendError" });
          return;
        }
        const data = (await res.json()) as StartResponse;
        const session = data.session;
        if (session === undefined || typeof session.realtimeToken !== "string" || session.realtimeToken === "") {
          dispatch({ type: "mark", id: optimistic.id, status: "failed" });
          dispatch({ type: "error", value: "sendError" });
          return;
        }
        const token = session.realtimeToken;
        writeStoredSession({ token, code: session.code });
        dispatch({
          type: "start",
          session: { code: session.code, status: session.status, visitorName: session.visitorName },
          token,
          messages: Array.isArray(data.messages) ? data.messages : [],
        });
      } catch {
        dispatch({ type: "mark", id: optimistic.id, status: "failed" });
        dispatch({ type: "error", value: "sendError" });
      } finally {
        dispatch({ type: "sending", value: false });
      }
    },
    [endpoint],
  );

  return { state, openPanel, closePanel, togglePanel, submitForm, sendMessage, retryMessage, startNewConversation, notifyTyping };
}
