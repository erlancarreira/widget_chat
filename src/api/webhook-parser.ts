// src/api/webhook-parser.ts — normalização defensiva de webhooks da Evolution API v2.
//
// Contrato: parseWebhookEvent(payload: unknown): ParsedWebhook.
// NUNCA lança exceção — qualquer payload inesperado/inválido vira { kind: "ignored", reason }.

import type { GroupParticipantChange, InboundMessage, PresenceChange, PresenceState } from "../types";

export type ParsedWebhook =
  | { kind: "message"; event: InboundMessage }
  | { kind: "connection"; state: string }
  | { kind: "group_participants"; event: GroupParticipantChange }
  | { kind: "presence"; event: PresenceChange }
  | { kind: "ignored"; reason: string };

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

  if (event === "group-participants.update") {
    return parseGroupParticipants(data);
  }

  if (event === "PRESENCE_UPDATE" || event === "presence.update") {
    return parsePresence(data);
  }

  if (event !== "messages.upsert") {
    return { kind: "ignored", reason: `evento não tratado: ${event}` };
  }

  // Evolution v2 pode mandar `data` como objeto único ou array de mensagens (queue-flush/bulk).
  // Contrato de evento único: devolve o PRIMEIRO item válido, não `items[0]` — senão um item
  // nulo/inválido na frente descartaria silenciosamente as mensagens válidas seguintes.
  const items: readonly unknown[] = Array.isArray(data) ? data : [data];
  let lastIgnored: ParsedWebhook = { kind: "ignored", reason: "messages.upsert sem data válido" };
  for (const item of items) {
    const parsed = parseMessageItem(item);
    if (parsed.kind !== "ignored") return parsed;
    lastIgnored = parsed;
  }
  return lastIgnored;
}

/**
 * Normaliza o evento `group-participants.update` da Evolution:
 *   { id: "…@g.us", participants: ["…@s.whatsapp.net"], author: "…@s.whatsapp.net",
 *     action: "add" | "remove" | "leave" | "promote" | "demote" }
 * Campos faltantes/fora do formato viram { kind: "ignored" } (nunca lança).
 */
function parseGroupParticipants(data: unknown): ParsedWebhook {
  if (!isRecord(data)) return { kind: "ignored", reason: "group-participants sem data" };

  const groupJid = data["id"];
  if (typeof groupJid !== "string" || groupJid.length === 0) {
    return { kind: "ignored", reason: "group-participants sem id (groupJid)" };
  }

  const rawParticipants = data["participants"];
  if (!Array.isArray(rawParticipants)) {
    return { kind: "ignored", reason: "group-participants sem participants[]" };
  }
  const participants: string[] = [];
  for (const p of rawParticipants) {
    if (typeof p === "string" && p.length > 0) participants.push(p);
  }
  if (participants.length === 0) {
    return { kind: "ignored", reason: "group-participants sem participantes válidos" };
  }

  const actionRaw = data["action"];
  const action = typeof actionRaw === "string" ? actionRaw : "unknown";
  const authorRaw = data["author"];
  const author = typeof authorRaw === "string" ? authorRaw : null;

  return {
    kind: "group_participants",
    event: { groupJid, participants, action, author, raw: data },
  };
}

/**
 * Normaliza o evento `PRESENCE_UPDATE` da Evolution (indicador "digitando…"):
 *   { id: "…@g.us", presences: { "5511…@s.whatsapp.net": { presence: "composing" } } }
 * Variações conhecidas: `presences` como mapa (forma atual) OU `participant`+`presence`
 * diretos (versões mais antigas), e `presence`/`lastKnownPresence` como campo.
 * NUNCA lança: qualquer formato estranho vira { kind: "ignored" }.
 */
function parsePresence(data: unknown): ParsedWebhook {
  if (!isRecord(data)) return { kind: "ignored", reason: "presence sem data" };

  const groupJid = typeof data["id"] === "string" && data["id"] ? data["id"] : null;

  let participantJid: string | null = null;
  let presenceRaw: unknown = null;

  const presences = data["presences"];
  if (isRecord(presences)) {
    const entries = Object.entries(presences);
    const first = entries[0];
    if (first !== undefined) {
      const [jid, info] = first;
      participantJid = jid;
      presenceRaw = isRecord(info) ? (info["presence"] ?? info["lastKnownPresence"]) : info;
    }
  } else {
    participantJid = typeof data["participant"] === "string" ? data["participant"] : null;
    presenceRaw = data["presence"] ?? data["lastKnownPresence"];
  }

  const presence = normalizePresence(presenceRaw);
  if (presence === null) return { kind: "ignored", reason: "presence sem estado reconhecível" };

  return {
    kind: "presence",
    event: { groupJid, participantJid, presence, raw: data },
  };
}

function normalizePresence(value: unknown): PresenceState | null {
  if (value === "composing" || value === "recording") return value;
  if (value === "paused") return "paused";
  // Algumas versões usam available/unavailable para "parou de digitar".
  if (value === "available" || value === "unavailable") return "paused";
  return null;
}
