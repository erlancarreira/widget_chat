// src/types.ts — tipos canônicos usados em TODO o SDK e nas tasks seguintes
export type ChatMessageDirection = "visitor" | "owner";
export type ChatMessageStatus = "pending" | "sent" | "failed";
export type ChatSessionStatus = "active" | "closed" | "failed";

export interface ChatMessage {
  id: string;
  sessionId: string;
  direction: ChatMessageDirection;
  body: string;
  status: ChatMessageStatus;
  waMessageId: string | null;
  createdAt: string; // ISO
}

export interface ChatSession {
  id: string;
  code: string;               // ex.: "A3F2"
  realtimeToken: string;      // token do canal broadcast
  visitorName: string;
  visitorPhone: string;       // só dígitos com DDI, ex.: 5511999999999
  visitorContact: string | null;
  groupJid: string | null;    // ex.: "120363...@g.us"
  status: ChatSessionStatus;
  createdAt: string;
  lastMessageAt: string | null;
}

export interface ChatConfig {
  enabled: boolean;
  projectName: string;        // assunto do grupo: "<projectName> — <visitante> (#code)"
  platformNumber: string;     // número da plataforma que recebe a conversa
  evolutionUrl: string;       // ex.: https://evolution.erlancarreira.com.br
  instance: string;
  apiKey: string;
  welcome: string;
  closeHours: number;         // inatividade p/ fechar (0 = nunca)
  leaveOnClose: boolean;
  webhookToken: string;
}

export interface ChatEvent {
  type: "message" | "session";
  message?: ChatMessage;
  status?: ChatSessionStatus;
}
