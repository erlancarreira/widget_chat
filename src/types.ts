// src/types.ts — tipos canônicos usados em TODO o SDK e nas tasks seguintes.

export type ChatMessageDirection = "visitor" | "owner";
export type ChatMessageStatus = "pending" | "sent" | "failed";
export type ChatSessionStatus = "active" | "closed" | "failed";

/** Mensagem persistida (domínio). */
export interface ChatMessage {
  id: string;
  sessionId: string;
  direction: ChatMessageDirection;
  body: string;
  status: ChatMessageStatus;
  waMessageId: string | null;
  createdAt: string; // ISO
}

/** Sessão de chat (um grupo do WhatsApp por visitante). */
export interface ChatSession {
  id: string;
  code: string; // ex.: "A3F2"
  realtimeToken: string; // token do canal broadcast
  visitorName: string;
  visitorPhone: string; // só dígitos com DDI, ex.: 5511999999999
  visitorContact: string | null;
  groupJid: string | null; // ex.: "120363...@g.us"
  status: ChatSessionStatus;
  createdAt: string;
  lastMessageAt: string | null;
}

/**
 * Configuração resolvida da plataforma. Montada pelo consumidor (LMS) a partir
 * das settings e injetada no bridge via `setConfig`.
 */
export interface ChatConfig {
  enabled: boolean;
  projectName: string; // assunto do grupo: "<projectName> — <visitante> (#code)"
  platformNumber: string; // número da plataforma que recebe a conversa
  evolutionUrl: string; // ex.: https://evolution.erlancarreira.com.br
  instance: string;
  apiKey: string;
  welcome: string;
  closeHours: number; // inatividade p/ fechar (0 = nunca)
  leaveOnClose: boolean;
  webhookToken: string;
}

/** Evento de tempo real publicado no canal broadcast `chat:<realtimeToken>`. */
export type ChatEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "session"; status: ChatSessionStatus };

/**
 * Mensagem de entrada normalizada do webhook da Evolution, independente do
 * formato bruto do payload.
 */
export interface InboundMessage {
  waMessageId: string;
  jid: string; // de onde veio (grupo = sessão)
  fromMe: boolean;
  senderJid: string | null;
  text: string | null; // apenas conversation/extendedTextMessage
  timestamp: number;
  raw: unknown;
}
