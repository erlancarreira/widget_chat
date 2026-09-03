// src/bridge/types.ts — PORTAS (hexagonal) da bridge.
//
// Só contratos: nenhuma implementação vive aqui. O núcleo (router, bridge server) depende
// destas interfaces; adapters concretos (Supabase, Evolution, widget) vivem fora — Task 6+
// implementa SessionStore, Task 7 o RealtimeTransport/RealtimeHandle via Supabase Realtime.
//
// Os tipos canônicos de domínio (ChatSession/ChatMessage/ChatEvent/…) vêm de src/types.ts
// (Task 1) e NÃO são redefinidos aqui.

import type {
  ChatEvent,
  ChatMessage,
  ChatMessageDirection,
  ChatMessageStatus,
  ChatSession,
  ChatSessionStatus,
} from "../types";

/** Persistência de sessões/mensagens vista pela bridge. */
export interface SessionStore {
  createSession(input: {
    code: string;
    realtimeToken: string;
    visitorName: string;
    visitorPhone: string;
    visitorContact?: string | null;
    groupJid: string | null;
  }): Promise<ChatSession>;
  getSessionByToken(token: string): Promise<ChatSession | null>;
  getSessionByGroupJid(jid: string): Promise<ChatSession | null>;
  appendMessage(input: {
    sessionId: string;
    direction: ChatMessageDirection;
    body: string;
    waMessageId?: string | null;
    status?: ChatMessageStatus;
  }): Promise<ChatMessage>;
  /** Atualiza o status de uma mensagem já persistida (pending → sent/failed). */
  updateMessageStatus(id: string, status: ChatMessageStatus): Promise<void>;
  listMessages(sessionId: string, afterIso?: string | null): Promise<ChatMessage[]>;
  /**
   * Busca uma mensagem já persistida pelo `waMessageId` dentro da sessão (`null` se não
   * existir). Suporta a idempotência de reentrega do webhook: a Evolution reenvia a
   * mesma mensagem quando devolvemos `handled:false`, e o bridge precisa reconhecer o
   * duplicado em vez de anexar/publicar de novo.
   */
  findMessageByWaId(sessionId: string, waMessageId: string): Promise<ChatMessage | null>;
  /** Registra o waMessageId de uma mensagem enviada por ESTA instância (dedupe de eco). */
  registerSentMessageId(sessionId: string, waMessageId: string): Promise<void>;
  isEcho(sessionId: string, waMessageId: string): Promise<boolean>;
  touchSession(sessionId: string, atIso: string): Promise<void>;
  setGroupJid(sessionId: string, groupJid: string): Promise<void>;
  markStatus(sessionId: string, status: ChatSessionStatus, reason?: string): Promise<void>;
  countRecentSessionsByIpHash(ipHash: string, windowMs: number): Promise<number>;
}

/** Publicação server-side de eventos para o canal de uma sessão (fire-and-forget). */
export interface RealtimeTransport {
  publish(realtimeToken: string, event: ChatEvent): Promise<void>;
}

/**
 * Assinatura client-side do mesmo canal (usada pelo widget — Task 9).
 * `subscribe` devolve o unsubscribe; `onStatus` reporta conexão do transporte.
 */
export interface RealtimeHandle {
  subscribe(
    realtimeToken: string,
    onEvent: (e: ChatEvent) => void,
    onStatus?: (s: "open" | "closed") => void,
  ): () => void;
}

/** Injeção de relógio (testes determinísticos). */
export type Clock = () => Date;

export interface ChatLimiterResult {
  success: boolean;
}

/** Rate limiter (chave → janela). Implementações: memória, Redis, … */
export type ChatLimiter = (
  key: string,
  limit: number,
  windowMs: number,
) => ChatLimiterResult | Promise<ChatLimiterResult>;

/**
 * Saída de ConversationRouter.decide — união discriminada por `action`: só o ramo
 * "route" carrega sessão/direção/texto (obrigatórios), eliminando o risco de
 * `decision.session` ser undefined em tempo de execução no consumidor (Task 6).
 *
 * Os `?: undefined` explícitos no 2º ramo preservam o typecheck de acessos sem
 * narrowing (ex.: `d.session` → `ChatSession | undefined` em testes já escritos);
 * após `if (d.action === "route")` os campos continuam obrigatórios.
 */
export type RouterDecision =
  | { action: "route"; session: ChatSession; direction: ChatMessageDirection; text: string }
  | {
      action: "echo" | "unknown_session" | "not_text" | "ignore";
      session?: undefined;
      direction?: undefined;
      text?: undefined;
    };
