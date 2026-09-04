// src/types.ts — tipos canônicos usados em TODO o SDK e nas tasks seguintes.

export type ChatMessageDirection = "visitor" | "owner" | "system";
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
  /** Modo da conversa: "group" (grupo por visitante, padrão) ou "direct" (1:1 com a plataforma). */
  mode?: "group" | "direct";
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
  /** true (padrão) = cria um grupo por visitante; false = conversa 1:1 direta com a plataforma. */
  createGroup?: boolean;
  /** URL pública da imagem de capa do grupo (opcional; ignora se vazia). */
  groupImage?: string;
}

/** Estado de presença (digitação) normalizado da Evolution. */
export type PresenceState = "composing" | "paused" | "recording";

/** Evento de tempo real publicado no canal broadcast `chat:<realtimeToken>`. */
export type ChatEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "session"; status: ChatSessionStatus }
  /** Indicador de digitação: `from` diz quem está digitando (dona da plataforma
   *  ou visitante) para o widget exibir os "3 pontinhos" apenas quando a OUTRA
   *  ponta digita. */
  | { type: "typing"; isTyping: boolean; from: "owner" | "visitor" };

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

/**
 * Mudança de participantes em um grupo WhatsApp, normalizada a partir do evento
 * `group-participants.update` da Evolution API. Usada para notificar no chat quando
 * alguém entra, sai ou é removido/adicionado ao grupo da sessão.
 */
export interface GroupParticipantChange {
  /** JID do grupo (ex.: "120363000000000001@g.us"). */
  groupJid: string;
  /** JIDs dos participantes afetados (ex.: ["5511999998888@s.whatsapp.net"]). */
  participants: string[];
  /** Ação da Evolution: "add" | "remove" | "leave" | "promote" | "demote". */
  action: "add" | "remove" | "leave" | "promote" | "demote" | (string & {});
  /** Quem executou a ação (JID); nulo para "leave" (o próprio participante saiu). */
  author: string | null;
  raw: unknown;
}

/**
 * Mudança de presença (digitação) normalizada do evento `PRESENCE_UPDATE` da
 * Evolution API. Usada para mostrar o indicador "digitando…" no widget quando a
 * outra ponta (dona da plataforma ou visitante) está compondo mensagem.
 *
 * - `groupJid`: JID do grupo (modo grupo) ou nulo (modo direto 1:1, em que o
 *   próprio número da plataforma é a conversa).
 * - `participantJid`: quem está digitando (em grupo, o participante específico;
 *   em direto, costuma vir nulo e tratamos como a dona da plataforma).
 * - `presence`: "composing"/"recording" = está digitando; "paused" = parou.
 */
export interface PresenceChange {
  groupJid: string | null;
  participantJid: string | null;
  presence: PresenceState;
  raw: unknown;
}
