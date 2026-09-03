import { describe, expect, it, vi } from "vitest";
import { createEvolutionClient, EvolutionApiError } from "../src/api/client";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("createEvolutionClient", () => {
  it("sendText retorna waMessageId e envia apikey + payload v2", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ key: { id: "MSG-1", remoteJid: "x@g.us", fromMe: true } }));
    const client = createEvolutionClient({ baseUrl: "https://evo.test", apiKey: "k", fetchImpl });
    const r = await client.sendText("inst", "120363@g.us", "olá");
    expect(r.waMessageId).toBe("MSG-1");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://evo.test/message/sendText/inst");
    expect((init.headers as Record<string, string>)["apikey"]).toBe("k");
    expect(JSON.parse(String(init.body))).toEqual({ number: "120363@g.us", text: "olá" });
  });

  it("createGroup aceita { id } ou { group: { id } }", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ group: { id: "120363-abc@g.us" } }));
    const client = createEvolutionClient({ baseUrl: "https://evo.test", apiKey: "k", fetchImpl });
    const r = await client.createGroup("inst", "Site — João (#A3F2)", ["5511@s.whatsapp.net"]);
    expect(r.groupJid).toBe("120363-abc@g.us");
  });

  it("erro HTTP lança EvolutionApiError com status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const client = createEvolutionClient({ baseUrl: "https://evo.test", apiKey: "k", fetchImpl });
    await expect(client.sendText("inst", "n", "t")).rejects.toBeInstanceOf(EvolutionApiError);
  });

  it("connectQR extrai base64/pairingCode", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ base64: "data:image/png;base64,AAA", pairingCode: "ABCD-1234" }));
    const client = createEvolutionClient({ baseUrl: "https://evo.test", apiKey: "k", fetchImpl });
    expect(await client.connectQR("inst")).toEqual({ qrBase64: "data:image/png;base64,AAA", pairingCode: "ABCD-1234" });
  });

  it("setWebhook posta { webhook: {...} }", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({}));
    const client = createEvolutionClient({ baseUrl: "https://evo.test", apiKey: "k", fetchImpl });
    await client.setWebhook("inst", "https://site/api/webhooks/whatsapp?token=t", ["MESSAGES_UPSERT"]);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.method as string)).toBe("POST");
    expect(JSON.parse(String(init.body)).webhook.url).toContain("/api/webhooks/whatsapp");
  });

  // Contratos do plano ainda não cobertos pelos testes acima — todos definidos antes da implementação.

  it("createGroup aceita resposta plana { id }", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ id: "120363-abc@g.us" }));
    const client = createEvolutionClient({ baseUrl: "https://evo.test", apiKey: "k", fetchImpl });
    const r = await client.createGroup("inst", "Site — João (#A3F2)", ["5511@s.whatsapp.net"]);
    expect(r.groupJid).toBe("120363-abc@g.us");
  });

  it("createGroup envia POST /group/create/{instance} com subject, participants e description", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ id: "120363-abc@g.us" }));
    const client = createEvolutionClient({ baseUrl: "https://evo.test", apiKey: "k", fetchImpl });
    await client.createGroup("inst", "Site — João (#A3F2)", ["5511@s.whatsapp.net"], "Turma A");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://evo.test/group/create/inst");
    expect(JSON.parse(String(init.body))).toEqual({
      subject: "Site — João (#A3F2)",
      participants: ["5511@s.whatsapp.net"],
      description: "Turma A",
    });
  });

  it("leaveGroup faz DELETE /group/leave/{instance} com body { groupId }", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({}));
    const client = createEvolutionClient({ baseUrl: "https://evo.test", apiKey: "k", fetchImpl });
    await client.leaveGroup("inst", "120363-abc@g.us");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://evo.test/group/leave/inst");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(String(init.body))).toEqual({ groupId: "120363-abc@g.us" });
  });

  it("getConnectionState lê json.instance.state via GET /instance/connectionState/{instance}", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ instance: { state: "open" } }));
    const client = createEvolutionClient({ baseUrl: "https://evo.test", apiKey: "k", fetchImpl });
    expect(await client.getConnectionState("inst")).toBe("open");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://evo.test/instance/connectionState/inst");
    expect(init.method).toBe("GET");
  });

  it("connectQR tolera resposta só com { code } (qrBase64: null)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ code: "ABCD-1234" }));
    const client = createEvolutionClient({ baseUrl: "https://evo.test", apiKey: "k", fetchImpl });
    expect(await client.connectQR("inst")).toEqual({ qrBase64: null, pairingCode: "ABCD-1234" });
  });

  it("setWebhook posta payload v2 completo em /webhook/set/{instance}", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({}));
    const client = createEvolutionClient({ baseUrl: "https://evo.test", apiKey: "k", fetchImpl });
    await client.setWebhook("inst", "https://site/api/webhooks/whatsapp", ["MESSAGES_UPSERT"]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://evo.test/webhook/set/inst");
    expect(JSON.parse(String(init.body))).toEqual({
      webhook: { enabled: true, url: "https://site/api/webhooks/whatsapp", events: ["MESSAGES_UPSERT"], webhookByEvents: false, webhookBase64: false },
    });
  });

  it("EvolutionApiError carrega status, body e operation na mensagem", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const client = createEvolutionClient({ baseUrl: "https://evo.test", apiKey: "k", fetchImpl });
    const error = await client.sendText("inst", "n", "t").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EvolutionApiError);
    const apiError = error as EvolutionApiError;
    expect(apiError.status).toBe(401);
    expect(apiError.body).toBe("unauthorized");
    expect(apiError.message).toBe("Evolution sendText falhou (401)");
  });
});
