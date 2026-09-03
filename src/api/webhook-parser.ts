// src/api/webhook-parser.ts — normalização defensiva de webhooks da Evolution API v2.
//
// Contrato: parseWebhookEvent(payload: unknown): ParsedWebhook.
// NUNCA lança exceção — qualquer payload inesperado/inválido vira { kind: "ignored", reason }.

export type ParsedWebhook =
  | { kind: "message"; event: InboundMessage }
  | { kind: "connection"; state: string }
  | { kind: "ignored"; reason: string };

// Contrato (verbatim do plano): InboundMessage abaixo. `raw` carrega o item original de
// `data` (sem normalizar) para auditoria/reprocesso; o parser nunca devolve `text: null`
// em kind "message" (texto vazio → ignored), mas o tipo admite null para consumidores.
export interface InboundMessage {
  waMessageId: string;
  jid: string;            // remoteJid (grupo → "@g.us")
  fromMe: boolean;
  senderJid: string | null;
  text: string | null;    // conversation | extendedTextMessage.text (trim)
  timestamp: number;      // segundos
  raw: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Texto só sai de `conversation` ou `extendedTextMessage.text`; string vazia/só espaços → null.
function textFromMessage(message: unknown): string | null {
  if (!isRecord(message)) return null;
  const conversation = message["conversation"];
  if (typeof conversation === "string") {
    const trimmed = conversation.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const extended = message["extendedTextMessage"];
  if (isRecord(extended)) {
    const text = extended["text"];
    if (typeof text === "string") {
      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }
  return null;
}

// messageTimestamp em segundos (aceita número ou string numérica; ausente/inválido → 0).
function timestampSeconds(value: unknown): number {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(seconds) ? Math.floor(seconds) : 0;
}

function parseMessageItem(item: unknown): ParsedWebhook {
  if (!isRecord(item)) return { kind: "ignored", reason: "messages.upsert sem data válido" };

  const key = isRecord(item["key"]) ? item["key"] : null;
  const waMessageId = key?.["id"];
  const jid = key?.["remoteJid"];
  if (typeof waMessageId !== "string" || waMessageId.length === 0) {
    return { kind: "ignored", reason: "mensagem sem key.id" };
  }
  if (typeof jid !== "string" || jid.length === 0) {
    return { kind: "ignored", reason: "mensagem sem key.remoteJid" };
  }

  const text = textFromMessage(item["message"]);
  if (text === null) {
    return { kind: "ignored", reason: "mensagem sem texto (conversation/extendedTextMessage)" };
  }

  const senderJid = key?.["participant"];
  return {
    kind: "message",
    event: {
      waMessageId,
      jid,
      fromMe: key?.["fromMe"] === true,
      senderJid: typeof senderJid === "string" ? senderJid : null,
      text,
      timestamp: timestampSeconds(item["messageTimestamp"]),
      raw: item,
    },
  };
}

export function parseWebhookEvent(payload: unknown): ParsedWebhook {
  if (!isRecord(payload)) return { kind: "ignored", reason: "payload não é um objeto" };

  const event = payload["event"];
  if (typeof event !== "string") return { kind: "ignored", reason: "payload sem campo event" };

  const data = payload["data"];

  if (event === "connection.update") {
    const state = isRecord(data) ? data["state"] : undefined;
    if (typeof state === "string" && state.length > 0) return { kind: "connection", state };
    return { kind: "ignored", reason: "connection.update sem state" };
  }

  if (event !== "messages.upsert") {
    return { kind: "ignored", reason: `evento não tratado: ${event}` };
  }

  // Evolution v2 pode mandar `data` como objeto único ou array de mensagens.
  const items: readonly unknown[] = Array.isArray(data) ? data : [data];
  return parseMessageItem(items[0]);
}
