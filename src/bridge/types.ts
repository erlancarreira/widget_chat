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
