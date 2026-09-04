// test/next/chat-routes.test.ts — factories de rotas Next (src/next) com Request/Response puros.
//
// Estratégia: bridge REAL (ChatBridge) sobre o MemoryStore compartilhado (Task 6),
// EvolutionClient 100% mockado (vi.fn) e RealtimeTransport como espião. As rotas são
// testadas de ponta a ponta pelo comportamento HTTP observável — status + corpo JSON —
// sem importar "next" (o plano o proíbe; App Router aceita Request/Response padrão).
//
// Padrão de uso no consumidor (LMS), documentado também em src/next/chat-routes.ts:
//   const handlers = createChatRoutes(deps);
//   export const GET = (req: Request) => handlers.GET(req);
//   export const POST = (req: Request) => handlers.POST(req);

import { describe, expect, it, vi } from "vitest";
import { ChatBridge } from "../../src/bridge/bridge";
import { ChatError } from "../../src/errors";
import { createChatRoutes, createWebhookRoute } from "../../src/next/chat-routes";
import type { ChatRoutesDeps } from "../../src/next/chat-routes";
import type { EvolutionClient, CreateGroupResult, SendTextResult } from "../../src/api/client";
import type { ChatLimiter, RealtimeTransport } from "../../src/bridge/types";
import type { ChatConfig, ChatSession, ChatSessionStatus } from "../../src/types";
import type { MemorySessionStore } from "../helpers/memory";
import { createMemoryStore } from "../helpers/memory";

const NOW = new Date("2025-03-01T10:00:00.000Z");

const VISITOR_PHONE = "5511999998888";
const PLATFORM_JID = "5511988887777@s.whatsapp.net";
const GROUP_JID = "120363000000000001@g.us";
const SENT_WA_ID = "WA-SENT-1";
const INSTANCE = "principal";
const WEBHOOK_TOKEN = "webhook-token";

function config(over: Partial<ChatConfig> = {}): ChatConfig {
  return {
    enabled: true,
    projectName: "LMS",
    platformNumber: "5511988887777",
    evolutionUrl: "https://evo.example.com",
    instance: INSTANCE,
    apiKey: "api-key",
    welcome: "Olá! Como podemos ajudar?",
    closeHours: 0,
    leaveOnClose: false,
    webhookToken: WEBHOOK_TOKEN,
    ...over,
  };
}

interface ClientOverrides {
  sendText?: (instance: string, number: string, text: string) => Promise<SendTextResult>;
  createGroup?: (instance: string, subject: string, participants: string[]) => Promise<CreateGroupResult>;
}

function mockClient(over: ClientOverrides = {}) {
  const sendText = vi.fn(
    over.sendText ?? (async (): Promise<SendTextResult> => ({ waMessageId: SENT_WA_ID })),
  );
  const createGroup = vi.fn(
    over.createGroup ?? (async (): Promise<CreateGroupResult> => ({ groupJid: GROUP_JID })),
  );
  const client: EvolutionClient = {
    sendText,
    createGroup,
    setGroupPicture: vi.fn(async () => undefined),
    sendPresence: vi.fn(async () => undefined),
    validateWhatsAppNumbers: vi.fn(
      async (_instance: string, numbers: string[]) =>
        numbers.map(() => ({ exists: true as const, jid: null })),
    ),
    leaveGroup: vi.fn(async () => undefined),
    getConnectionState: vi.fn(async () => "open" as const),
    connectQR: vi.fn(async () => ({ qrBase64: null, pairingCode: null })),
    setWebhook: vi.fn(async () => undefined),
    createInstance: vi.fn(async () => undefined),
    ensureInstance: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  };
  return { client, sendText, createGroup };
}

interface SetupOptions {
  cfg?: Partial<ChatConfig>;
  client?: ClientOverrides;
  limiter?: ChatLimiter;
  getIpHash?: (req: Request) => string | null;
}

function setup(opts: SetupOptions = {}) {
  const store = createMemoryStore();
  const { client, sendText, createGroup } = mockClient(opts.client);
  const publish = vi.fn<RealtimeTransport["publish"]>(async () => undefined);
  const transport: RealtimeTransport = { publish };
  const bridge = new ChatBridge({ client, store, transport, clock: () => NOW });
  // getConfig async: prova que a rota resolve Promise<ChatConfig> a cada request.
  const getConfig = vi.fn(async () => config(opts.cfg));
  const deps: ChatRoutesDeps = { bridge, getConfig };
  if (opts.limiter !== undefined) deps.limiter = opts.limiter;
  if (opts.getIpHash !== undefined) deps.getIpHash = opts.getIpHash;
  const routes = createChatRoutes(deps);
  const webhook = createWebhookRoute({ bridge, getConfig });
  return { store, bridge, routes, webhook, publish, sendText, createGroup, getConfig };
}

async function seedSession(
  store: MemorySessionStore,
  opts: { realtimeToken?: string; groupJid?: string | null; status?: ChatSessionStatus; mode?: "group" | "direct" } = {},
): Promise<ChatSession> {
  const session = await store.createSession({
    code: "A3F2",
    realtimeToken: opts.realtimeToken ?? "RT-1",
    visitorName: "João",
    visitorPhone: VISITOR_PHONE,
    groupJid: opts.groupJid === undefined ? GROUP_JID : opts.groupJid,
    mode: opts.mode ?? "group",
  });
  if (opts.status !== undefined) await store.markStatus(session.id, opts.status);
  return session;
}

function postJson(url: string, body: unknown, headers?: Record<string, string>): Request {
  return new Request(`http://x${url}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(headers === undefined ? {} : { headers }),
  });
}

function getUrl(url: string): Request {
  return new Request(`http://x${url}`);
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const VALID_START = { name: "João Silva", phone: VISITOR_PHONE, message: "Oi, quero comprar" };

function upsertPayload(over: { id?: string; jid?: string; fromMe?: boolean; text?: string } = {}): unknown {
  return {
    event: "messages.upsert",
    source: INSTANCE,
    data: [
      {
        key: {
          id: over.id ?? "WA-IN-1",
          remoteJid: over.jid ?? GROUP_JID,
          fromMe: over.fromMe ?? false,
        },
        message: { conversation: over.text ?? "Olá, visitante" },
        messageTimestamp: 1740823200,
        instanceName: INSTANCE,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// POST /api/chat — abrir chat (sem token)
// ---------------------------------------------------------------------------

describe("POST /api/chat sem token (abrir chat)", () => {
  it("enabled=false → 404 {error:'not_found'} sem tocar em nada (feature oculta)", async () => {
    const { routes, store, createGroup, sendText } = setup({ cfg: { enabled: false } });
    const res = await routes.POST(postJson("/api/chat", VALID_START));
    expect(res.status).toBe(404);
    expect(await jsonOf(res)).toEqual({ error: "not_found" });
    expect(store.sessions).toHaveLength(0);
    expect(createGroup).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("honeypot preenchido → 200 falso sucesso {code:'XXXX',status:'closed'} e nada persistido", async () => {
    const { routes, store, createGroup, sendText } = setup();
    const res = await routes.POST(
      postJson("/api/chat", { ...VALID_START, name: "Bot", honeypot: "spam" }),
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body["session"]).toEqual({ code: "XXXX", status: "closed" });
    expect(body["messages"]).toEqual([]);
    // forma exata: sem realtimeToken/visitorName no falso sucesso
    expect(Object.keys(body["session"] as object).sort()).toEqual(["code", "status"]);
    expect(store.sessions).toHaveLength(0);
    expect(createGroup).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("validação de nome → 422 {error, field:'name'}", async () => {
    const { routes, store } = setup();
    const res = await routes.POST(postJson("/api/chat", { ...VALID_START, name: "J" }));
    expect(res.status).toBe(422);
    const body = await jsonOf(res);
    expect(body["error"]).toContain("Nome");
    expect(body["field"]).toBe("name");
    expect(store.sessions).toHaveLength(0);
  });

  it("validação de telefone → 422 {error, field:'phone'}", async () => {
    const { routes } = setup();
    const res = await routes.POST(postJson("/api/chat", { ...VALID_START, phone: "12" }));
    expect(res.status).toBe(422);
    const body = await jsonOf(res);
    expect(body["error"]).toContain("Telefone");
    expect(body["field"]).toBe("phone");
  });

  it("corpo não-JSON → 422 {error} sem field", async () => {
    const { routes } = setup();
    const res = await routes.POST(postJson("/api/chat", "isso não é json"));
    expect(res.status).toBe(422);
    const body = await jsonOf(res);
    expect(typeof body["error"]).toBe("string");
    expect("field" in body).toBe(false);
  });

  it("rate_limited do bridge (sessões por IP) → 429 {error}", async () => {
    const { routes, store } = setup({ getIpHash: () => "hash-1" });
    store.recentByIpHash = 5; // limite da bridge: 5 sessões / 10 min
    const res = await routes.POST(postJson("/api/chat", VALID_START));
    expect(res.status).toBe(429);
    const body = await jsonOf(res);
    expect(body["error"]).toContain("Limite");
    expect(store.ipHashChecks[0]?.[0]).toBe("hash-1");
  });

  it("limiter DI negando → 429 sem chamar a Evolution", async () => {
    const limiter = vi.fn<ChatLimiter>(async () => ({ success: false }));
    const { routes, createGroup } = setup({ limiter, getIpHash: () => "ip-hash" });
    const res = await routes.POST(postJson("/api/chat", VALID_START));
    expect(res.status).toBe(429);
    expect((await jsonOf(res))["error"]).toBeTruthy();
    expect(limiter).toHaveBeenCalledTimes(1);
    expect(limiter.mock.calls[0]?.[0]).toBe("ip-hash");
    expect(createGroup).not.toHaveBeenCalled();
  });

  it("group_create_failed → 502 {error} (após retry só com a plataforma)", async () => {
    const { routes, store, createGroup } = setup({
      client: { createGroup: async () => { throw new Error("boom"); } },
    });
    const res = await routes.POST(postJson("/api/chat", VALID_START));
    expect(res.status).toBe(502);
    expect((await jsonOf(res))["error"]).toContain("grupo");
    expect(createGroup).toHaveBeenCalledTimes(2);
    expect(createGroup.mock.calls[1]?.[2]).toEqual([PLATFORM_JID]);
    expect(store.sessions).toHaveLength(0);
  });

  it("send_failed → 502 {error} e sessão marcada failed", async () => {
    const { routes, store } = setup({
      client: { sendText: async () => { throw new Error("boom"); } },
    });
    const res = await routes.POST(postJson("/api/chat", VALID_START));
    expect(res.status).toBe(502);
    expect((await jsonOf(res))["error"]).toContain("primeira mensagem");
    expect(store.sessions[0]?.status).toBe("failed");
  });

  it("ok → 200 {session:{code,status,realtimeToken,visitorName},messages} sem vazar telefone/jid", async () => {
    const { routes, store, createGroup } = setup();
    const res = await routes.POST(postJson("/api/chat", VALID_START));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const session = body["session"] as Record<string, unknown>;
    expect(Object.keys(session).sort()).toEqual(["code", "realtimeToken", "status", "visitorName"]);
    expect(session["code"]).toMatch(/^[A-Z2-9]{4}$/);
    expect(session["status"]).toBe("active");
    expect(session["visitorName"]).toBe("João Silva");
    expect(typeof session["realtimeToken"]).toBe("string");
    expect((session["realtimeToken"] as string).length).toBe(32);
    const messages = body["messages"] as Record<string, unknown>[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.["body"]).toBe("Oi, quero comprar");
    expect(messages[0]?.["direction"]).toBe("visitor");
    expect(messages[0]?.["status"]).toBe("sent");
    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(store.sessions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/chat — mensagem (com token)
// ---------------------------------------------------------------------------

describe("POST /api/chat com token (mensagem do visitante)", () => {
  it("ok → 200 {message} relayado ao grupo", async () => {
    const { routes, store, sendText } = setup();
    await seedSession(store);
    const res = await routes.POST(postJson("/api/chat", { token: "RT-1", message: "Alguém aí?" }));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const message = body["message"] as Record<string, unknown>;
    expect(message["body"]).toBe("Alguém aí?");
    expect(message["direction"]).toBe("visitor");
    expect(message["status"]).toBe("sent");
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("token desconhecido → 404 {error}", async () => {
    const { routes } = setup();
    const res = await routes.POST(postJson("/api/chat", { token: "nope", message: "oi" }));
    expect(res.status).toBe(404);
    expect((await jsonOf(res))["error"]).toContain("não encontrada");
  });

  it("sessão fechada → 409 {error}", async () => {
    const { routes, store } = setup();
    await seedSession(store, { status: "closed" });
    const res = await routes.POST(postJson("/api/chat", { token: "RT-1", message: "oi" }));
    expect(res.status).toBe(409);
    expect((await jsonOf(res))["error"]).toContain("encerrada");
  });

  it("mensagem vazia → 422 {error, field:'message'}", async () => {
    const { routes, store } = setup();
    await seedSession(store);
    const res = await routes.POST(postJson("/api/chat", { token: "RT-1", message: "  " }));
    expect(res.status).toBe(422);
    expect((await jsonOf(res))["field"]).toBe("message");
  });

  it("send_failed no relay → 502 {error} e mensagem marcada failed", async () => {
    const { routes, store } = setup({
      client: { sendText: async () => { throw new Error("boom"); } },
    });
    await seedSession(store);
    const res = await routes.POST(postJson("/api/chat", { token: "RT-1", message: "oi" }));
    expect(res.status).toBe(502);
    expect((await jsonOf(res))["error"]).toContain("Falha ao enviar");
    expect(store.messages[0]?.status).toBe("failed");
  });

  it("enabled=false NÃO bloqueia sessão existente (feature oculta só vale p/ abertura)", async () => {
    const { routes, store } = setup({ cfg: { enabled: false } });
    await seedSession(store);
    const res = await routes.POST(postJson("/api/chat", { token: "RT-1", message: "oi" }));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/chat?token=…&after=…
// ---------------------------------------------------------------------------

describe("GET /api/chat (replay de histórico)", () => {
  it("ok → 200 {session:{code,status,visitorName},messages}", async () => {
    const { routes, store } = setup();
    const session = await seedSession(store);
    await store.appendMessage({ sessionId: session.id, direction: "owner", body: "Olá!" });
    const res = await routes.GET(getUrl("/api/chat?token=RT-1"));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const returned = body["session"] as Record<string, unknown>;
    expect(Object.keys(returned).sort()).toEqual(["code", "status", "visitorName"]);
    expect(returned["code"]).toBe("A3F2");
    expect(returned["status"]).toBe("active");
    expect(returned["visitorName"]).toBe("João");
    const messages = body["messages"] as Record<string, unknown>[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.["body"]).toBe("Olá!");
  });

  it("after=ISO filtra mensagens anteriores", async () => {
    const { routes, store } = setup();
    const session = await seedSession(store);
    await store.appendMessage({ sessionId: session.id, direction: "owner", body: "antiga" });
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await routes.GET(getUrl(`/api/chat?token=RT-1&after=${future}`));
    expect(res.status).toBe(200);
    expect((await jsonOf(res))["messages"]).toEqual([]);
  });

  it("sem token → 400 {error}", async () => {
    const { routes } = setup();
    const res = await routes.GET(getUrl("/api/chat"));
    expect(res.status).toBe(400);
    expect((await jsonOf(res))["error"]).toBeTruthy();
  });

  it("token sem sessão → 404", async () => {
    const { routes } = setup();
    const res = await routes.GET(getUrl("/api/chat?token=nope"));
    expect(res.status).toBe(404);
    expect((await jsonOf(res))["error"]).toBe("session_not_found");
  });

  it("enabled=false não afeta replay de sessão existente", async () => {
    const { routes, store } = setup({ cfg: { enabled: false } });
    await seedSession(store);
    const res = await routes.GET(getUrl("/api/chat?token=RT-1"));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST webhook
// ---------------------------------------------------------------------------

describe("POST /api/chat/webhook", () => {
  it("token errado → 200 {ignored:true} sem vazar info nem processar", async () => {
    const { webhook, store, publish } = setup();
    await seedSession(store);
    const res = await webhook.POST(postJson(`/api/chat/webhook?token=wrong`, upsertPayload()));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(Object.keys(body)).toEqual(["ignored"]);
    expect(body["ignored"]).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(store.messages).toHaveLength(0);
  });

  it("sem token nenhum → 200 {ignored:true}", async () => {
    const { webhook } = setup();
    const res = await webhook.POST(postJson("/api/chat/webhook", upsertPayload()));
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ignored: true });
  });

  it("token válido via header x-webhook-token + mensagem do grupo → 200 {handled:true} + publish", async () => {
    const { webhook, store, publish } = setup();
    await seedSession(store);
    const res = await webhook.POST(
      postJson("/api/chat/webhook", upsertPayload({ fromMe: true, text: "Prezado, temos sim!" }), {
        "x-webhook-token": WEBHOOK_TOKEN,
      }),
    );
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ handled: true });
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]?.direction).toBe("owner");
    expect(publish).toHaveBeenCalledWith("RT-1", expect.objectContaining({ type: "message" }));
  });

  it("token válido via query + payload de sessão desconhecida → 200 {handled:false}", async () => {
    const { webhook, publish } = setup();
    const res = await webhook.POST(
      postJson(`/api/chat/webhook?token=${WEBHOOK_TOKEN}`, upsertPayload({ jid: "999@g.us" })),
    );
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ handled: false });
    expect(publish).not.toHaveBeenCalled();
  });

  it("corpo não-JSON com token válido → 200 {ignored:true} (nunca 500)", async () => {
    const { webhook } = setup();
    const res = await webhook.POST(
      postJson(`/api/chat/webhook?token=${WEBHOOK_TOKEN}`, "não é json"),
    );
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ ignored: true });
  });
});

// ---------------------------------------------------------------------------
// Contrato da fábrica (resolução do controller): funções puras, sem "next"
// ---------------------------------------------------------------------------

describe("contrato das fábricas", () => {
  it("createChatRoutes devolve {GET,POST} como funções puras (forwarding do LMS)", async () => {
    const { routes } = setup();
    expect(typeof routes.GET).toBe("function");
    expect(typeof routes.POST).toBe("function");
    // exatamente o padrão que o LMS usa no route.ts:
    const handlers = routes;
    const GET = (req: Request) => handlers.GET(req);
    const POST = (req: Request) => handlers.POST(req);
    expect(typeof GET).toBe("function");
    expect(typeof POST).toBe("function");
    const res = await GET(getUrl("/api/chat?token=nope"));
    expect(res.status).toBe(404);
  });

  it("createWebhookRoute devolve {POST}", () => {
    const { webhook } = setup();
    expect(typeof webhook.POST).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Mapeamento code → HTTP por DUCK-TYPE (bug cross-bundle do tsup)
// ---------------------------------------------------------------------------

describe("mapeamento code→HTTP sem instanceof ChatError", () => {
  // Réplica exata do que o tsup produz em produção: o entry /bridge embute a SUA cópia de
  // ChatError, então o objeto que chega na rota /next NÃO passa em `instanceof ChatError`.
  // Se algum dia o mapeamento voltar a usar instanceof, estes testes falham.
  function foreignChatError(message: string, code: string): Error {
    const error = new Error(message);
    error.name = "ChatError";
    Object.defineProperty(error, "code", { value: code });
    expect(error instanceof ChatError).toBe(false); // premissa do teste
    return error;
  }

  const CASES: { code: string; message: string; status: number; error: string; field?: string }[] = [
    { code: "invalid_input", message: "Nome deve ter entre 2 e 60 caracteres", status: 422, error: "Nome deve ter entre 2 e 60 caracteres", field: "name" },
    { code: "invalid_input", message: "Telefone inválido", status: 422, error: "Telefone inválido", field: "phone" },
    { code: "invalid_input", message: "JSON inválido", status: 422, error: "JSON inválido" },
    { code: "rate_limited", message: "Limite de sessões atingido", status: 429, error: "Limite de sessões atingido" },
    { code: "session_not_found", message: "Sessão não encontrada", status: 404, error: "Sessão não encontrada" },
    { code: "session_closed", message: "Sessão encerrada", status: 409, error: "Sessão encerrada" },
    { code: "group_create_failed", message: "Falha ao criar o grupo na Evolution", status: 502, error: "Falha ao criar o grupo na Evolution" },
    { code: "send_failed", message: "Falha ao enviar a primeira mensagem para o grupo", status: 502, error: "Falha ao enviar a primeira mensagem para o grupo" },
    { code: "store_error", message: "Chat não configurado", status: 502, error: "Chat não configurado" },
    { code: "disabled", message: "Chat desabilitado", status: 404, error: "not_found" },
  ];

  it.each(CASES)(
    "bridge lança code=$code (cópia estrangeira) → $status sem degradar p/ 500",
    async ({ code, message, status, error, field }) => {
      const { routes, bridge } = setup();
      vi.spyOn(bridge, "startChat").mockRejectedValue(foreignChatError(message, code));

      const res = await routes.POST(postJson("/api/chat", VALID_START));

      expect(res.status).toBe(status);
      const body = await jsonOf(res);
      expect(body["error"]).toBe(error);
      if (field === undefined) expect("field" in body).toBe(false);
      else expect(body["field"]).toBe(field);
    },
  );

  it("plain object {code} sem message → status correto com code no corpo (erro serializado)", async () => {
    const { routes, bridge } = setup();
    vi.spyOn(bridge, "startChat").mockRejectedValue({ code: "session_closed" } as never);

    const res = await routes.POST(postJson("/api/chat", VALID_START));

    expect(res.status).toBe(409);
    expect(await jsonOf(res)).toEqual({ error: "session_closed" });
  });

  it("erro sem code (Error puro) → 500 genérico, sem vazar a mensagem", async () => {
    const { routes, bridge } = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(bridge, "startChat").mockRejectedValue(new Error("detalhe interno sigiloso"));

    const res = await routes.POST(postJson("/api/chat", VALID_START));

    expect(res.status).toBe(500);
    expect(await jsonOf(res)).toEqual({ error: "erro interno" });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("code desconhecido → 500 genérico (não inventa status p/ code fora do contrato)", async () => {
    const { routes, bridge } = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(bridge, "startChat").mockRejectedValue(foreignChatError("boom", "algum_code_novo"));

    const res = await routes.POST(postJson("/api/chat", VALID_START));

    expect(res.status).toBe(500);
    expect(await jsonOf(res)).toEqual({ error: "erro interno" });
    log.mockRestore();
  });

  it("ChatError LOCAL ainda mapeia igual (a classe continua funcionando na rota)", async () => {
    const { routes, bridge } = setup();
    vi.spyOn(bridge, "startChat").mockRejectedValue(new ChatError("Sessão encerrada", "session_closed"));

    const res = await routes.POST(postJson("/api/chat", VALID_START));

    expect(res.status).toBe(409);
    expect(await jsonOf(res)).toEqual({ error: "Sessão encerrada" });
  });
});
