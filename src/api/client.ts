// src/api/client.ts — Adapter REST da Evolution API v2 (fetch injetável p/ testes).
import { ChatError } from "../errors";
import type { PresenceState } from "../types";

export interface EvolutionFetch { (url: string, init: RequestInit): Promise<Response>; } // ponto de injeção (DI)

export interface SendTextResult { waMessageId: string; }
export interface CreateGroupResult { groupJid: string; }

export interface EvolutionClient {
  sendText(instance: string, number: string, text: string): Promise<SendTextResult>;
  /**
   * Verifica se os números existem no WhatsApp (Baileys onWhatsApp via REST).
   * Evolution v2: POST /chat/whatsappNumbers/{instance}, body { numbers } — a resposta
   * vem na MESMA ordem dos números pedidos. Falha de shape vira EvolutionApiError.
   */
  validateWhatsAppNumbers(
    instance: string,
    numbers: string[],
  ): Promise<Array<{ exists: boolean; jid: string | null }>>;
  /** Envia presença de digitação ("digitando…") para o número/grupo. `presence` =
   *  "composing" | "recording" (digitando) ou "paused" (parou). Best-effort: a
   *  presença é anunciada pela CONTA CONECTADA à instância, não por terceiros. */
  sendPresence(instance: string, number: string, presence: PresenceState): Promise<void>;
  createGroup(instance: string, subject: string, participants: string[], description?: string): Promise<CreateGroupResult>;
  setGroupPicture(instance: string, groupJid: string, image: string): Promise<void>;
  leaveGroup(instance: string, groupJid: string): Promise<void>;
  /** Encerra a sessão WhatsApp da instância (desvincula o dispositivo). */
  logout(instance: string): Promise<void>;
  getConnectionState(instance: string): Promise<"open" | "connecting" | "close">;
  connectQR(instance: string): Promise<{ qrBase64: string | null; pairingCode: string | null }>;
  setWebhook(instance: string, url: string, events: string[]): Promise<void>;
  /** Cria a instância na Evolution (one-time). Exige a apiKey com permissão de criação. */
  createInstance(instance: string, integration?: "WHATSAPP-BAILEYS" | "WHATSAPP-BUSINESS"): Promise<void>;
  /**
   * Garante que a instância existe (idempotente): se `getConnectionState` responde
   * (qualquer estado), não faz nada; só chama `createInstance` quando a leitura falha
   * (instância inexistente). Assim o LMS gerencia o ciclo de vida sem criar manualmente
   * na Evolution — o único passo humano é escanear o QR de pareamento.
   */
  ensureInstance(instance: string): Promise<void>;
}

export class EvolutionApiError extends Error {
  constructor(readonly status: number, readonly body: string, operation: string) {
    super(`Evolution ${operation} falhou (${status})`);
    this.name = "EvolutionApiError";
  }
}

interface JsonOk { operation: string; status: number; text: string; json: Record<string, unknown>; }

// Lê path aninhado (ex.: "key", "id") sem lançar: devolve undefined se faltar ou não for objeto.
function readPath(json: Record<string, unknown>, ...path: string[]): unknown {
  let cur: unknown = json;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function createEvolutionClient(cfg: { baseUrl: string; apiKey: string; fetchImpl?: EvolutionFetch }): EvolutionClient {
  const doFetch: EvolutionFetch = cfg.fetchImpl ?? fetch;
  const base = cfg.baseUrl.replace(/\/+$/, ""); // normaliza p/ evitar double slash na concatenação
  const headers = { "content-type": "application/json", apikey: cfg.apiKey };

  // 1 retransmissão em falha de TRANSPORTE (DNS/conexão caiu, rede socket abortada):
  // reinicializar a Evolution/redeploy derruba conexões esporadicamente e o chamador
  // (startChat) não tem a rede de segurança do webhook (que reenvia em erro). É seguro
  // retransmitir: o erro aconteceu ANTES de qualquer resposta — o servidor não processou.
  // Resposta HTTP != 2xx (EvolutionApiError) NÃO se retransmite: é veredito definitivo.
  const NETWORK_RETRIES = 1;

  async function request(operation: string, method: string, path: string, body?: unknown): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= NETWORK_RETRIES; attempt++) {
      try {
        const response = await doFetch(`${base}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) throw new EvolutionApiError(response.status, await response.text(), operation);
        return response;
      } catch (error) {
        if (error instanceof EvolutionApiError) throw error;
        lastError = error;
      }
    }
    // Normaliza: nenhum chamador deve tratar TypeError/SyntaxError cru de rede.
    throw new EvolutionApiError(0, `falha de rede: ${String(lastError)}`, operation);
  }

  // Contrato: toda falha de HTTP/parse/shape é EvolutionApiError (a ponte captura via instanceof).
  async function requestJson(operation: string, method: string, path: string, body?: unknown): Promise<JsonOk> {
    const response = await request(operation, method, path, body);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new EvolutionApiError(response.status, text, operation);
    }
    if (!parsed || typeof parsed !== "object") throw new EvolutionApiError(response.status, text, operation);
    return { operation, status: response.status, text, json: parsed as Record<string, unknown> };
  }

  function requireString(res: JsonOk, ...path: string[]): string {
    const value = readPath(res.json, ...path);
    if (typeof value !== "string" || value === "") throw new EvolutionApiError(res.status, res.text, res.operation);
    return value;
  }

  // Estado da instância (open/connecting/close); lança EvolutionApiError se a resposta
  // for inválida OU a instância não existir (a Evolution devolve erro nesse caso).
  async function fetchConnectionState(instance: string): Promise<"open" | "connecting" | "close"> {
    const res = await requestJson("getConnectionState", "GET", `/instance/connectionState/${instance}`);
    const state = readPath(res.json, "instance", "state");
    if (state === "open" || state === "connecting" || state === "close") return state;
    throw new EvolutionApiError(res.status, res.text, res.operation);
  }

  return {
    async sendText(instance, number, text) {
      const res = await requestJson("sendText", "POST", `/message/sendText/${instance}`, { number, text });
      return { waMessageId: requireString(res, "key", "id") };
    },

    async validateWhatsAppNumbers(instance, numbers) {
      const res = await requestJson(
        "validateWhatsAppNumbers",
        "POST",
        `/chat/whatsappNumbers/${instance}`,
        { numbers },
      );
      // Algumas builds embrulham em { response: [...] }; a maioria devolve o array puro.
      const raw = Array.isArray(res.json)
        ? res.json
        : Array.isArray(res.json["response"])
          ? (res.json["response"] as unknown[])
          : null;
      if (raw === null) throw new EvolutionApiError(res.status, res.text, res.operation);
      return raw.map((item) => {
        const rec = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
        return {
          exists: rec["exists"] === true,
          jid: typeof rec["jid"] === "string" ? rec["jid"] : null,
        };
      });
    },

    async sendPresence(instance, number, presence) {
      // Evolution v2: POST /message/sendPresence/{instance} — anuncia a presença da
      // conta conectada à instância (não de terceiros). A resposta 200 é suficiente.
      await request("sendPresence", "POST", `/message/sendPresence/${instance}`, {
        number,
        presence,
      });
    },

    async createGroup(instance, subject, participants, description) {
      const payload = description === undefined ? { subject, participants } : { subject, participants, description };
      const res = await requestJson("createGroup", "POST", `/group/create/${instance}`, payload);
      const groupJid = readPath(res.json, "group", "id") ?? res.json.id; // mesmo derivador de antes, sem cast
      if (typeof groupJid !== "string" || groupJid === "") {
        throw new ChatError("Evolution createGroup: groupJid ausente/inválido na resposta", "send_failed");
      }
      return { groupJid };
    },

    async setGroupPicture(instance, groupJid, image) {
      // Evolution v2: POST /group/updateGroupPicture/{instance} com { groupJid, image }
      // (image = URL pública ou base64). Imagem é cosmética: qualquer falha vira EvolutionApiError.
      await request("setGroupPicture", "POST", `/group/updateGroupPicture/${instance}`, { groupJid, image });
    },

    async leaveGroup(instance, groupJid) {
      await request("leaveGroup", "DELETE", `/group/leave/${instance}`, { groupId: groupJid });
    },

    async logout(instance) {
      await request("logout", "DELETE", `/instance/logout/${instance}`);
    },

    async getConnectionState(instance) {
      return fetchConnectionState(instance);
    },

    async connectQR(instance) {
      const res = await requestJson("connectQR", "GET", `/instance/connect/${instance}`);
      const base64 = readPath(res.json, "base64");
      const pairingCode = readPath(res.json, "pairingCode");
      const code = readPath(res.json, "code");
      return {
        qrBase64: typeof base64 === "string" ? base64 : null,
        pairingCode: typeof pairingCode === "string" ? pairingCode : typeof code === "string" ? code : null,
      };
    },

    async createInstance(instance, integration = "WHATSAPP-BAILEYS") {
      await request("createInstance", "POST", "/instance/create", { instanceName: instance, integration });
    },

    async ensureInstance(instance) {
      try {
        await fetchConnectionState(instance); // existe (qualquer estado) → ok, não faz nada
        return;
      } catch {
        // instância inexistente (ou erro de leitura) → tenta criar
      }
      await this.createInstance(instance);
    },

    async setWebhook(instance, url, events) {
      // webhookByEvents:true → entrega SÓ os eventos listados (explícito e determinístico).
      // Assim garantimos que PRESENCE_UPDATE chega sem depender do default "todos os eventos"
      // da instância (que pode não incluir presença).
      await request("setWebhook", "POST", `/webhook/set/${instance}`, {
        webhook: { enabled: true, url, events, webhookByEvents: true, webhookBase64: false },
      });
    },
  };
}
