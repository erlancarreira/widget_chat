// test/helpers/memory.ts — fake in-memory da porta SessionStore, compartilhado entre tasks.
//
// Fiél ao contrato: appendMessage gera id + createdAt e devolve o ChatMessage completo;
// listMessages respeita o filtro `afterIso`; findMessageByWaId varre `messages` por
// (sessionId, waMessageId); isEcho usa um Set alimentado por registerSentMessageId;
// markStatus/updateMessageStatus mutam o que foi persistido.
//
// `countRecentSessionsByIpHash` não tem como ser derivada dos dados (a porta não guarda
// ipHash na sessão), então o fake expõe `recentByIpHash` para o teste fixar o contador, e
// `ipHashChecks` para pinar com quais chaves/janelas a bridge chamou.

import type { SessionStore } from "../../src/bridge/types";
import type { ChatMessage, ChatSession } from "../../src/types";

export interface MemorySessionStore extends SessionStore {
  /** Sessões persistidas (ordem de criação). */
  readonly sessions: ChatSession[];
  /** Mensagens persistidas (ordem de append). */
  readonly messages: ChatMessage[];
  /** Valor devolvido por countRecentSessionsByIpHash. */
  recentByIpHash: number;
  /** (chave, janelaMs) recebidos em countRecentSessionsByIpHash, na ordem. */
  readonly ipHashChecks: [string, number][];
}

export function createMemoryStore(): MemorySessionStore {
  const sessions: ChatSession[] = [];
  const messages: ChatMessage[] = [];
  const echo = new Set<string>();
  const ipHashChecks: [string, number][] = [];
  let seq = 0;

  const nextId = (prefix: string): string => `${prefix}-${(seq += 1)}`;
  const isoNow = (): string => new Date().toISOString();

  function sessionById(id: string): ChatSession {
    const found = sessions.find((s) => s.id === id);
    if (found === undefined) throw new Error(`MemoryStore: sessão inexistente "${id}"`);
    return found;
  }

  function messageById(id: string): ChatMessage {
    const found = messages.find((m) => m.id === id);
    if (found === undefined) throw new Error(`MemoryStore: mensagem inexistente "${id}"`);
    return found;
  }

  const store: MemorySessionStore = {
    sessions,
    messages,
    recentByIpHash: 0,
    ipHashChecks,

    async createSession(input) {
      const session: ChatSession = {
        id: nextId("ses"),
        code: input.code,
        realtimeToken: input.realtimeToken,
        visitorName: input.visitorName,
        visitorPhone: input.visitorPhone,
        visitorContact: input.visitorContact ?? null,
        groupJid: input.groupJid,
        mode: input.mode ?? "group",
        status: "active",
        createdAt: isoNow(),
        lastMessageAt: null,
        consentAt: input.consentAt ?? null,
      };
      sessions.push(session);
      return session;
    },

    async getSessionByToken(token) {
      return sessions.find((s) => s.realtimeToken === token) ?? null;
    },

    async getSessionByGroupJid(jid) {
      return sessions.find((s) => s.groupJid === jid) ?? null;
    },

    async getSessionByVisitorPhone(phone) {
      // Mais recente sessão ativa daquele telefone (modo direto 1:1).
      const found = sessions.find((s) => s.visitorPhone === phone && s.status === "active");
      return found ?? null;
    },

    async appendMessage(input) {
      const message: ChatMessage = {
        id: nextId("msg"),
        sessionId: input.sessionId,
        direction: input.direction,
        body: input.body,
        status: input.status ?? "sent",
        waMessageId: input.waMessageId ?? null,
        createdAt: isoNow(),
      };
      messages.push(message);
      return message;
    },

    async updateMessageStatus(id, status) {
      messageById(id).status = status;
    },

    async listMessages(sessionId, afterIso) {
      return messages.filter(
        (m) => m.sessionId === sessionId && (afterIso === undefined || afterIso === null || m.createdAt > afterIso),
      );
    },

    async findMessageByWaId(sessionId, waMessageId) {
      return messages.find((m) => m.sessionId === sessionId && m.waMessageId === waMessageId) ?? null;
    },

    async registerSentMessageId(sessionId, waMessageId) {
      echo.add(`${sessionId}:${waMessageId}`);
    },

    async isEcho(sessionId, waMessageId) {
      return echo.has(`${sessionId}:${waMessageId}`);
    },

    async touchSession(sessionId, atIso) {
      sessionById(sessionId).lastMessageAt = atIso;
    },

    async setGroupJid(sessionId, groupJid) {
      sessionById(sessionId).groupJid = groupJid;
    },

    async markStatus(sessionId, status) {
      sessionById(sessionId).status = status;
    },

    async countRecentSessionsByIpHash(ipHash, windowMs) {
      ipHashChecks.push([ipHash, windowMs]);
      return store.recentByIpHash;
    },
  };

  return store;
}
