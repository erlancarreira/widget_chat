// src/api/client.ts — Adapter REST da Evolution API v2 (fetch injetável p/ testes).

export interface EvolutionFetch { (url: string, init: RequestInit): Promise<Response>; } // ponto de injeção (DI)

export interface SendTextResult { waMessageId: string; }
export interface CreateGroupResult { groupJid: string; }

export interface EvolutionClient {
  sendText(instance: string, number: string, text: string): Promise<SendTextResult>;
  createGroup(instance: string, subject: string, participants: string[], description?: string): Promise<CreateGroupResult>;
  leaveGroup(instance: string, groupJid: string): Promise<void>;
  getConnectionState(instance: string): Promise<"open" | "connecting" | "close">;
  connectQR(instance: string): Promise<{ qrBase64: string | null; pairingCode: string | null }>;
  setWebhook(instance: string, url: string, events: string[]): Promise<void>;
}

export class EvolutionApiError extends Error {
  constructor(readonly status: number, readonly body: string, operation: string) { super(`Evolution ${operation} falhou (${status})`); }
}

export function createEvolutionClient(cfg: { baseUrl: string; apiKey: string; fetchImpl?: EvolutionFetch }): EvolutionClient {
  const doFetch: EvolutionFetch = cfg.fetchImpl ?? fetch;
  const headers = { "content-type": "application/json", apikey: cfg.apiKey };

  async function request(operation: string, method: string, path: string, body?: unknown): Promise<Response> {
    const response = await doFetch(`${cfg.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new EvolutionApiError(response.status, await response.text(), operation);
    return response;
  }

  async function requestJson<T>(operation: string, method: string, path: string, body?: unknown): Promise<T> {
    return (await request(operation, method, path, body).then((response) => response.json())) as T;
  }

  return {
    async sendText(instance, number, text) {
      const json = await requestJson<{ key: { id: string } }>("sendText", "POST", `/message/sendText/${instance}`, { number, text });
      return { waMessageId: json.key.id };
    },

    async createGroup(instance, subject, participants, description) {
      const payload = description === undefined ? { subject, participants } : { subject, participants, description };
      const json = await requestJson<{ id?: string; group?: { id: string } }>("createGroup", "POST", `/group/create/${instance}`, payload);
      return { groupJid: (json.group?.id ?? json.id) as string };
    },

    async leaveGroup(instance, groupJid) {
      await request("leaveGroup", "DELETE", `/group/leave/${instance}`, { groupId: groupJid });
    },

    async getConnectionState(instance) {
      const json = await requestJson<{ instance: { state: "open" | "connecting" | "close" } }>(
        "getConnectionState", "GET", `/instance/connectionState/${instance}`,
      );
      return json.instance.state;
    },

    async connectQR(instance) {
      const json = await requestJson<{ base64?: string | null; pairingCode?: string | null; code?: string | null }>(
        "connectQR", "GET", `/instance/connect/${instance}`,
      );
      return { qrBase64: json.base64 ?? null, pairingCode: json.pairingCode ?? json.code ?? null };
    },

    async setWebhook(instance, url, events) {
      await request("setWebhook", "POST", `/webhook/set/${instance}`, {
        webhook: { enabled: true, url, events, webhookByEvents: false, webhookBase64: false },
      });
    },
  };
}
