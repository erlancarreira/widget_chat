// test/bridge/bridge.test.ts — orquestração do ChatBridge com dependências injetadas.
//
// Estratégia: EvolutionClient 100% mockado (vi.fn), SessionStore pelo fake compartilhado
// (test/helpers/memory.ts) e RealtimeTransport como espião. Relógio fixo via `clock` para
// pinar timestamps. Asserções são de COMPORTAMENTO observável (o que foi persistido /
// publicado / enviado), não de estrutura interna.

import { describe, expect, it, vi } from "vitest";
import { ChatBridge } from "../../src/bridge/bridge";
import { formatFirstMessage, formatFollowup } from "../../src/bridge/format";
import { ChatError } from "../../src/errors";
import type { EvolutionClient, CreateGroupResult, SendTextResult } from "../../src/api/client";
import { EvolutionApiError } from "../../src/api/client";
import type { RealtimeTransport } from "../../src/bridge/types";
import type { ChatConfig, ChatSession, ChatSessionStatus } from "../../src/types";
import type { MemorySessionStore } from "../helpers/memory";
import { createMemoryStore } from "../helpers/memory";

const NOW = new Date("2025-03-01T10:00:00.000Z");
const NOW_ISO = NOW.toISOString();

const VISITOR_PHONE = "5511999998888";
const VISITOR_JID = "5511999998888@s.whatsapp.net";
const PLATFORM_PHONE = "5511988887777";
const PLATFORM_JID = "5511988887777@s.whatsapp.net";
const GROUP_JID = "120363000000000001@g.us";
const SENT_WA_ID = "WA-SENT-1";
const INSTANCE = "principal";

function config(over: Partial<ChatConfig> = {}): ChatConfig {
  return {
    enabled: true,
    projectName: "LMS",
    platformNumber: PLATFORM_PHONE,
    evolutionUrl: "https://evo.example.com",
    instance: INSTANCE,
    apiKey: "api-key",
    welcome: "Olá! Como podemos ajudar?",
    closeHours: 0,
    leaveOnClose: false,
    webhookToken: "webhook-token",
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
  const setGroupPicture = vi.fn(async (_instance: string, _jid: string, _url: string) => undefined);
  const client: EvolutionClient = {
    sendText,
    createGroup,
    setGroupPicture,
    sendPresence: vi.fn(async () => undefined),
    leaveGroup: vi.fn(async () => undefined),
    getConnectionState: vi.fn(async () => "open" as const),
    connectQR: vi.fn(async () => ({ qrBase64: null, pairingCode: null })),
    setWebhook: vi.fn(async () => undefined),
    createInstance: vi.fn(async () => undefined),
    ensureInstance: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  };
  return { client, sendText, createGroup, setGroupPicture };
}

interface SetupOptions {
  client?: ClientOverrides;
  cfg?: Partial<ChatConfig>;
  store?: MemorySessionStore;
}

function setup(opts: SetupOptions = {}) {
  const store = opts.store ?? createMemoryStore();
  const { client, sendText, createGroup, setGroupPicture } = mockClient(opts.client);
  // T do mock anotado com a assinatura da porta: dá tipos corretos a publish.mock.calls.
  const publish = vi.fn<RealtimeTransport["publish"]>(async () => undefined);
  const transport: RealtimeTransport = { publish };
  const bridge = new ChatBridge({ client, store, transport, clock: () => NOW });
  bridge.setConfig(config(opts.cfg));
  return { bridge, store, transport, publish, client, sendText, createGroup, setGroupPicture };
}

async function seedSession(
  store: MemorySessionStore,
  opts: { realtimeToken?: string; groupJid?: string | null; status?: ChatSessionStatus; visitorName?: string; mode?: "group" | "direct" } = {},
): Promise<ChatSession> {
  const session = await store.createSession({
    code: "A3F2",
    realtimeToken: opts.realtimeToken ?? "RT-1",
    visitorName: opts.visitorName ?? "João",
    visitorPhone: VISITOR_PHONE,
    groupJid: opts.groupJid === undefined ? GROUP_JID : opts.groupJid,
    mode: opts.mode ?? "group",
  });
  if (opts.status !== undefined) await store.markStatus(session.id, opts.status);
  return session;
}

async function captureError(promise: Promise<unknown>): Promise<ChatError> {
  try {
    await promise;
  } catch (error) {
    expect(error, "erro lançado deveria ser ChatError").toBeInstanceOf(ChatError);
    return error as ChatError;
  }
  throw new Error("esperava um ChatError, mas a promise resolveu");
}

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
        message: { conversation: over.text ?? "oi" },
        messageTimestamp: 1725400000,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// format.ts (Strategy isolada)
// ---------------------------------------------------------------------------

describe("format", () => {
  it("formatFirstMessage: prefixo 🆕 + código + nome + quebra de linha + texto", () => {
    expect(formatFirstMessage("A3F2", "João", "Quero comprar")).toBe("🆕 #A3F2 — João (site):\nQuero comprar");
  });

  it("formatFollowup: \"nome (site): texto\" em linha única", () => {
    expect(formatFollowup("João", "tem desconto?")).toBe("João (site): tem desconto?");
  });
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

describe("ChatBridge config", () => {
  it("getConfig devolve a config injetada via setConfig", () => {
    const { bridge } = setup();
    expect(bridge.getConfig().projectName).toBe("LMS");
    bridge.setConfig(config({ projectName: "Outro" }));
    expect(bridge.getConfig().projectName).toBe("Outro");
  });

  it("sem setConfig → getConfig lança ChatError", async () => {
    const store = createMemoryStore();
    const { client } = mockClient();
    const bare = new ChatBridge({ client, store, transport: { publish: async () => undefined } });
    expect(() => bare.getConfig()).toThrow(ChatError);
    // F3: config ausente é falha de infraestrutura (store/config), não entrada do
    // visitante — Task 8 mapeia store_error → 500/502, nunca um 422 de campo.
    await expect(captureError(bare.startChat({ name: "João", phone: VISITOR_PHONE, message: "oi" }))).resolves.toMatchObject({
      code: "store_error",
    });
  });

  it("getConfig sem setConfig → ChatError com code store_error (não invalid_input)", () => {
    const store = createMemoryStore();
    const { client } = mockClient();
    const bare = new ChatBridge({ client, store, transport: { publish: async () => undefined } });
    let thrown: unknown;
    try {
      bare.getConfig();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ChatError);
    expect((thrown as ChatError).code).toBe("store_error");
  });
});

// ---------------------------------------------------------------------------
// startChat
// ---------------------------------------------------------------------------

describe("ChatBridge.startChat", () => {
  it("fluxo feliz: subject/participants exatos, mensagem inicial formatada, sessão retornada", async () => {
    const { bridge, store, publish, createGroup, sendText } = setup();

    const result = await bridge.startChat({
      name: "João Silva",
      phone: "(11) 99999-8888",
      message: "Quero comprar",
    });

    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(createGroup.mock.calls[0]?.[0]).toBe(INSTANCE);
    expect(createGroup.mock.calls[0]?.[1]).toBe(`LMS — João Silva (#${result.session.code})`);
    expect(createGroup.mock.calls[0]?.[2]).toEqual([VISITOR_JID, PLATFORM_JID]);

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[0]).toBe(INSTANCE);
    expect(sendText.mock.calls[0]?.[1]).toBe(GROUP_JID);
    expect(sendText.mock.calls[0]?.[2]).toBe(`🆕 #${result.session.code} — João Silva (site):\nQuero comprar`);

    // o criador já vê a própria mensagem: nada é publicado no canal realtime
    expect(publish).not.toHaveBeenCalled();

    expect(result.session.status).toBe("active");
    expect(result.session.groupJid).toBe(GROUP_JID);
    expect(result.session.visitorName).toBe("João Silva");
    expect(result.session.visitorPhone).toBe(VISITOR_PHONE); // normalizado (DDI 55)
    expect(result.session.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
    expect(result.session.realtimeToken.length).toBeGreaterThan(20);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      sessionId: result.session.id,
      direction: "visitor",
      body: "Quero comprar",
      status: "sent",
      waMessageId: SENT_WA_ID,
    });
    expect(store.messages).toEqual(result.messages);
  });

  it("modo direto (createGroup:false): não cria grupo, envia 1:1 p/ plataforma e marca sessão direta", async () => {
    const { bridge, publish, createGroup, sendText } = setup({ cfg: { createGroup: false } });

    const result = await bridge.startChat({ name: "João Silva", phone: "(11) 99999-8888", message: "Quero comprar" });

    expect(createGroup).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[1]).toBe(PLATFORM_JID); // destino = número da plataforma (1:1)
    expect(publish).not.toHaveBeenCalled();
    expect(result.session.groupJid).toBeNull();
    expect(result.session.mode).toBe("direct");
  });

  it("modo grupo com groupImage: define a capa do grupo via setGroupPicture", async () => {
    const { bridge, setGroupPicture } = setup({ cfg: { groupImage: "https://img/x.png" } });

    await bridge.startChat({ name: "João", phone: VISITOR_PHONE, message: "oi" });

    expect(setGroupPicture).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setGroupPicture).mock.calls[0]).toEqual([INSTANCE, GROUP_JID, "https://img/x.png"]);
  });

  it("setGroupPicture não chamado sem groupImage (chamadas de tupla tipadas)", async () => {
    const { bridge, setGroupPicture } = setup();
    await bridge.startChat({ name: "João", phone: VISITOR_PHONE, message: "oi" });
    expect(setGroupPicture).not.toHaveBeenCalled();
  });

  it("registra o waMessageId enviado (dedupe de eco) e persiste contact", async () => {
    const { bridge, store } = setup();
    const { session } = await bridge.startChat({
      name: "João",
      phone: VISITOR_PHONE,
      message: "oi",
      contact: "5511999998888@s.whatsapp.net",
    });

    expect(await store.isEcho(session.id, SENT_WA_ID)).toBe(true);
    expect(store.sessions[0]?.visitorContact).toBe("5511999998888@s.whatsapp.net");
  });

  it("honeypot preenchido → sucesso falso sem criar grupo, enviar ou persistir", async () => {
    const { bridge, store, publish, createGroup, sendText } = setup();

    const result = await bridge.startChat({
      name: "Bot",
      phone: VISITOR_PHONE,
      message: "spam",
      honeypot: "tem-nada",
    });

    expect(createGroup).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(store.sessions).toHaveLength(0);
    expect(store.messages).toHaveLength(0);
    expect(result.session.status).toBe("closed");
    expect(result.session.code).toBe("XXXX");
    expect(result.session.groupJid).toBeNull();
    expect(result.messages).toEqual([]);
  });

  it("rate limit: 5 sessões recentes no ipHash → ChatError rate_limited (janela de 10min)", async () => {
    const { bridge, store, createGroup } = setup();
    store.recentByIpHash = 5;

    const error = await captureError(
      bridge.startChat({ name: "João", phone: VISITOR_PHONE, message: "oi", ipHash: "abc123" }),
    );
    expect(error.code).toBe("rate_limited");
    expect(store.ipHashChecks).toEqual([["abc123", 10 * 60 * 1000]]);
    expect(createGroup).not.toHaveBeenCalled();
    expect(store.sessions).toHaveLength(0);
  });

  it("rate limit: 4 sessões recentes → segue o fluxo normal", async () => {
    const { bridge, store, createGroup } = setup();
    store.recentByIpHash = 4;

    await bridge.startChat({ name: "João", phone: VISITOR_PHONE, message: "oi", ipHash: "abc123" });
    expect(createGroup).toHaveBeenCalledTimes(1);
  });

  it("sem ipHash → não consulta o contador de sessões por IP", async () => {
    const { bridge, store } = setup();
    store.recentByIpHash = 99;

    await bridge.startChat({ name: "João", phone: VISITOR_PHONE, message: "oi" });
    expect(store.ipHashChecks).toEqual([]);
  });

  it("valida name (2–60), message (1–1000) e phone → ChatError invalid_input sem efeitos", async () => {
    const cases: Array<[string, { name: string; phone: string; message: string }]> = [
      ["name com 1 caractere", { name: "J", phone: VISITOR_PHONE, message: "oi" }],
      ["name com 61 caracteres", { name: "a".repeat(61), phone: VISITOR_PHONE, message: "oi" }],
      ["name só espaços", { name: "   ", phone: VISITOR_PHONE, message: "oi" }],
      ["message vazio", { name: "João", phone: VISITOR_PHONE, message: "" }],
      ["message com 1001 caracteres", { name: "João", phone: VISITOR_PHONE, message: "a".repeat(1001) }],
      ["phone sem dígitos", { name: "João", phone: "---", message: "oi" }],
      ["phone curto demais", { name: "João", phone: "12345", message: "oi" }],
    ];

    for (const [label, input] of cases) {
      const { bridge, store, createGroup } = setup();
      const error = await captureError(bridge.startChat(input));
      expect(error.code, label).toBe("invalid_input");
      expect(createGroup, label).not.toHaveBeenCalled();
      expect(store.sessions, label).toHaveLength(0);
    }
  });

  it("aceita name/message nos limites exatos (2/60 e 1/1000)", async () => {
    for (const [name, message] of [
      ["Jo", "o"],
      ["a".repeat(60), "a".repeat(1000)],
    ] as const) {
      const { bridge } = setup();
      const { session } = await bridge.startChat({ name, phone: VISITOR_PHONE, message });
      expect(session.status, `name=${name.length}/msg=${message.length}`).toBe("active");
    }
  });

  it("createGroup falha nas duas tentativas → ChatError group_create_failed, nada persistido", async () => {
    const { bridge, store, sendText, createGroup } = setup({
      client: {
        createGroup: async () => {
          throw new EvolutionApiError(500, "boom", "createGroup");
        },
      },
    });

    const error = await captureError(bridge.startChat({ name: "João", phone: VISITOR_PHONE, message: "oi" }));
    expect(error.code).toBe("group_create_failed");
    expect(error.cause).toBeInstanceOf(EvolutionApiError);
    expect(createGroup).toHaveBeenCalledTimes(2);
    expect(sendText).not.toHaveBeenCalled();
    expect(store.sessions).toHaveLength(0);
    expect(store.messages).toHaveLength(0);
  });

  it("participante inválido (número do visitante) não aborta: retry só com a plataforma", async () => {
    const { bridge, store, createGroup } = setup({
      client: {
        createGroup: async (_instance, _subject, participants) => {
          if (participants.includes(VISITOR_JID)) {
            throw new EvolutionApiError(400, "participant invalid", "createGroup");
          }
          return { groupJid: GROUP_JID };
        },
      },
    });

    const { session } = await bridge.startChat({ name: "João", phone: VISITOR_PHONE, message: "oi" });

    // F1: o retry mantém o participante que controlamos (a plataforma) e descarta o do
    // visitante — era o número dele, vindo do formulário, que a Evolution rejeitou.
    expect(createGroup).toHaveBeenCalledTimes(2);
    expect(createGroup.mock.calls[0]?.[2]).toEqual([VISITOR_JID, PLATFORM_JID]);
    expect(createGroup.mock.calls[1]?.[2]).toEqual([PLATFORM_JID]);
    expect(session.groupJid).toBe(GROUP_JID);
    expect(store.sessions).toHaveLength(1);
  });

  it("visitor == platform → createGroup chamado UMA vez com lista dedupe", async () => {
    const { bridge, createGroup } = setup({ cfg: { platformNumber: VISITOR_PHONE } });

    await bridge.startChat({ name: "João", phone: VISITOR_PHONE, message: "oi" });

    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(createGroup.mock.calls[0]?.[2]).toEqual([VISITOR_JID]);
  });

  it("sendText da mensagem inicial falha → ChatError send_failed e sessão marcada failed", async () => {
    const { bridge, store } = setup({
      client: {
        sendText: async () => {
          throw new EvolutionApiError(503, "offline", "sendText");
        },
      },
    });

    const error = await captureError(bridge.startChat({ name: "João", phone: VISITOR_PHONE, message: "oi" }));
    expect(error.code).toBe("send_failed");
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]?.status).toBe("failed");
    expect(store.messages).toHaveLength(0);
  });

  it("reaproveita a sessão ativa do visitante (mesmo grupo) em vez de criar grupo novo", async () => {
    const { bridge, store, createGroup, sendText } = setup();
    const prior = await seedSession(store, { groupJid: GROUP_JID });

    const { session, messages } = await bridge.startChat({ name: "João", phone: VISITOR_PHONE, message: "Outra dúvida" });

    expect(createGroup).not.toHaveBeenCalled(); // não criou grupo novo
    expect(session.id).toBe(prior.id); // reaproveitou a sessão existente
    expect(session.realtimeToken).toBe(prior.realtimeToken);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe("Outra dúvida");
    expect(sendText.mock.calls[0]?.[1]).toBe(GROUP_JID); // enviou para o grupo existente
  });

  it("sessão existente fechada (visitante saiu) → cria novo grupo (não reaproveita)", async () => {
    const store = createMemoryStore();
    const { bridge, createGroup } = setup({ store });
    await seedSession(store, { groupJid: GROUP_JID, status: "closed" });
    await bridge.startChat({ name: "João", phone: VISITOR_PHONE, message: "Oi de novo" });
    expect(createGroup).toHaveBeenCalledTimes(1); // grupo novo, pois o anterior está fechado
  });

  it("reuse com grupo morto no WhatsApp (target_gone) → encerra sessão antiga e cria grupo novo", async () => {
    const store = createMemoryStore();
    const { bridge, createGroup, sendText } = setup({ store });
    const prior = await seedSession(store, { groupJid: GROUP_JID });
    // 1ª chamada (reuse) joga 404/group not found; nas seguintes (novo grupo) sucesso.
    let calls = 0;
    sendText.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new EvolutionApiError(404, "group not found", "sendText");
      return { waMessageId: SENT_WA_ID };
    });

    const { session } = await bridge.startChat({ name: "João", phone: VISITOR_PHONE, message: "Oi de novo" });

    expect(createGroup).toHaveBeenCalledTimes(1); // recriou grupo novo
    expect(session.id).not.toBe(prior.id); // não reaproveitou a sessão morta
    expect(store.sessions.find((s) => s.id === prior.id)?.status).toBe("closed"); // antiga encerrada
  });
});

// ---------------------------------------------------------------------------
// sendVisitorMessage (relay site → grupo)
// ---------------------------------------------------------------------------

describe("ChatBridge.sendVisitorMessage", () => {
  it("envia ao grupo, promove pending → sent, registra eco e toca a sessão", async () => {
    const { bridge, store, publish, sendText } = setup();
    const session = await seedSession(store);

    const message = await bridge.sendVisitorMessage("RT-1", "tem desconto?");

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[0]).toBe(INSTANCE);
    expect(sendText.mock.calls[0]?.[1]).toBe(GROUP_JID);
    expect(sendText.mock.calls[0]?.[2]).toBe("João (site): tem desconto?");

    expect(message).toMatchObject({
      sessionId: session.id,
      direction: "visitor",
      body: "tem desconto?",
      status: "sent",
      waMessageId: SENT_WA_ID,
    });
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]?.status).toBe("sent"); // updateMessageStatus, não novo append
    expect(store.messages[0]?.body).toBe("tem desconto?"); // corpo cru (sem prefixo do grupo)
    expect(await store.isEcho(session.id, SENT_WA_ID)).toBe(true);
    expect(store.sessions[0]?.lastMessageAt).toBe(NOW_ISO);
    expect(publish).not.toHaveBeenCalled(); // o widget já tem a msg localmente
  });

  it("não depende de o store mutar a referência: devolve a mensagem já sent", async () => {
    const store = createMemoryStore();
    // Um adapter real (SQL) persiste e devolve linhas novas — não muta o objeto que o
    // bridge recebeu no appendMessage. Sem cópia defensiva, o retorno diria "pending".
    store.updateMessageStatus = vi.fn(async () => undefined);
    const { bridge } = setup({ store });
    await seedSession(store);

    const message = await bridge.sendVisitorMessage("RT-1", "oi");
    expect(message.status).toBe("sent");
    expect(message.waMessageId).toBe(SENT_WA_ID);
  });

  it("token desconhecido → ChatError session_not_found", async () => {
    const { bridge, sendText } = setup();
    const error = await captureError(bridge.sendVisitorMessage("nope", "oi"));
    expect(error.code).toBe("session_not_found");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("sessão fechada → ChatError session_closed e nada é enviado", async () => {
    const { bridge, store, sendText } = setup();
    await seedSession(store, { status: "closed" });

    const error = await captureError(bridge.sendVisitorMessage("RT-1", "oi"));
    expect(error.code).toBe("session_closed");
    expect(sendText).not.toHaveBeenCalled();
    expect(store.messages).toHaveLength(0);
  });

  it("texto vazio → ChatError invalid_input", async () => {
    const { bridge, store, sendText } = setup();
    await seedSession(store);
    const error = await captureError(bridge.sendVisitorMessage("RT-1", "   "));
    expect(error.code).toBe("invalid_input");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("sessão sem groupJid (modo direto) → envia 1:1 para o número da plataforma e persiste", async () => {
    const { bridge, store, sendText } = setup();
    await seedSession(store, { groupJid: null, mode: "direct" });

    const msg = await bridge.sendVisitorMessage("RT-1", "oi");

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[0]).toBe(INSTANCE);
    expect(sendText.mock.calls[0]?.[1]).toBe(PLATFORM_JID); // destino = número da plataforma (1:1)
    expect(sendText.mock.calls[0]?.[2]).toContain("oi");
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]?.status).toBe("sent");
    expect(msg.status).toBe("sent");
  });

  it("instância offline (client rejeita) → status failed + rethrow ChatError send_failed", async () => {
    const { bridge, store } = setup({
      client: {
        sendText: async () => {
          throw new EvolutionApiError(503, "close", "sendText");
        },
      },
    });
    const session = await seedSession(store);

    const error = await captureError(bridge.sendVisitorMessage("RT-1", "oi"));
    expect(error.code).toBe("send_failed");
    expect(error.cause).toBeInstanceOf(EvolutionApiError);
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]?.status).toBe("failed");
    expect(store.messages[0]?.sessionId).toBe(session.id);
    expect(store.sessions[0]?.lastMessageAt).toBeNull(); // sessão não foi tocada
  });

  it("erro transitório 5xx na Evolution NÃO fecha a sessão (só 404/410 ou texto de grupo morto)", async () => {
    const { bridge, store, client } = setup({
      client: {
        sendText: async () => {
          throw new EvolutionApiError(500, "internal server error", "sendText");
        },
      },
    });
    await seedSession(store);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await captureError(bridge.sendVisitorMessage("RT-1", "oi"));

    expect(error.code).toBe("send_failed");
    // Sessão permanece ativa: um 5xx é transitório (redeploy/DNS), fechar seria
    // jogar a conversa fora por um soluço — o visitante só perde ESTA mensagem.
    expect(store.sessions[0]?.status).toBe("active");
    expect(client.leaveGroup).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("grupo inexistente (404) → fecha sessão, anexa aviso de sistema, sai do grupo órfão", async () => {
    const { bridge, store, publish, client } = setup({
      client: {
        sendText: async () => {
          throw new EvolutionApiError(404, "group not found", "sendText");
        },
      },
    });
    await seedSession(store);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await captureError(bridge.sendVisitorMessage("RT-1", "oi"));

    expect(error.code).toBe("send_failed");
    expect(store.sessions[0]?.status).toBe("closed");
    const sys = store.messages.find((m) => m.direction === "system");
    expect(sys?.body).toContain("não está mais disponível");
    const sessionEvent = publish.mock.calls.find((c) => c[1]?.type === "session");
    expect(sessionEvent?.[1]).toEqual({ type: "session", status: "closed" });
    expect(client.leaveGroup).toHaveBeenCalledWith(INSTANCE, GROUP_JID);
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// handleWebhook (grupo → store + canal realtime)
// ---------------------------------------------------------------------------

describe("ChatBridge.handleWebhook", () => {
  it("reply do dono (fromMe em grupo conhecido) → append owner + publish com o realtimeToken", async () => {
    const { bridge, store, publish } = setup();
    const session = await seedSession(store);

    const result = await bridge.handleWebhook(
      upsertPayload({ id: "WA-IN-1", fromMe: true, text: "Sim, tem desconto" }),
    );

    expect(result).toEqual({ handled: true });
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({
      sessionId: session.id,
      direction: "owner",
      body: "Sim, tem desconto",
      status: "sent",
      waMessageId: "WA-IN-1",
    });
    expect(store.sessions[0]?.lastMessageAt).toBe(NOW_ISO);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toBe(session.realtimeToken);
    expect(publish.mock.calls[0]?.[1]).toEqual({ type: "message", message: store.messages[0] });
  });

  it("visitor responde do próprio WhatsApp (fromMe=false no grupo) → direction visitor", async () => {
    const { bridge, store, publish } = setup();
    const session = await seedSession(store);

    const result = await bridge.handleWebhook(upsertPayload({ id: "WA-IN-2", fromMe: false, text: "boa tarde" }));

    expect(result).toEqual({ handled: true });
    expect(store.messages[0]?.direction).toBe("visitor");
    expect(store.messages[0]?.body).toBe("boa tarde");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toBe(session.realtimeToken);
  });

  it("eco de mensagem enviada por nós → handled:false, sem append e sem publish", async () => {
    const { bridge, store, publish } = setup();
    const session = await seedSession(store);
    await store.registerSentMessageId(session.id, "WA-ECHO");

    const result = await bridge.handleWebhook(upsertPayload({ id: "WA-ECHO", fromMe: true, text: "🆕 #A3F2 — João" }));

    expect(result).toEqual({ handled: false });
    expect(store.messages).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
    expect(store.sessions[0]?.lastMessageAt).toBeNull();
  });

  it("grupo sem sessão → handled:false, sem publish", async () => {
    const { bridge, store, publish } = setup();
    await seedSession(store, { groupJid: "120363other@g.us" });

    const result = await bridge.handleWebhook(upsertPayload({ jid: "120363unknown@g.us" }));

    expect(result).toEqual({ handled: false });
    expect(store.messages).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("mensagem direta (não @g.us) de visitante conhecido → route/handled:true (modo direto)", async () => {
    const { bridge, store, publish } = setup();
    const session = await seedSession(store);

    const result = await bridge.handleWebhook(
      upsertPayload({ id: "WA-DIRECT-1", jid: `${VISITOR_PHONE}@s.whatsapp.net`, fromMe: false, text: "Olá direto" }),
    );

    expect(result).toEqual({ handled: true });
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({ direction: "visitor", body: "Olá direto", status: "sent" });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(session.lastMessageAt).not.toBeNull();
  });

  it("mensagem direta (não @g.us) sem visitante correspondente → handled:false", async () => {
    const { bridge, store, publish } = setup();
    await seedSession(store);

    const result = await bridge.handleWebhook(
      upsertPayload({ id: "WA-DIRECT-2", jid: "5511000000000@s.whatsapp.net", fromMe: false, text: "estranho" }),
    );

    expect(result).toEqual({ handled: false });
    expect(store.messages).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("reentrega da mesma mensagem (webhook redelivered) → handled:true sem duplicar", async () => {
    const { bridge, store, publish } = setup();
    await seedSession(store);

    const payload = upsertPayload({ id: "WA-IN-DUP", fromMe: true, text: "Sim, tem desconto" });
    expect(await bridge.handleWebhook(payload)).toEqual({ handled: true });
    // A Evolution reenvia quando o retorno anterior foi handled:false (ex.: publish caiu).
    expect(await bridge.handleWebhook(payload)).toEqual({ handled: true });

    const dup = store.messages.filter((m) => m.waMessageId === "WA-IN-DUP");
    expect(dup).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1); // segunda passada não republica
  });

  it("connection.update → handled:false (sem tocar no store)", async () => {
    const { bridge, store, publish } = setup();
    const result = await bridge.handleWebhook({ event: "connection.update", data: { state: "open" } });
    expect(result).toEqual({ handled: false });
    expect(store.messages).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("payload lixo → handled:false", async () => {
    const { bridge } = setup();
    for (const payload of [null, undefined, 42, "text", {}, { event: "messages.upsert", data: [] }]) {
      expect(await bridge.handleWebhook(payload)).toEqual({ handled: false });
    }
  });

  it("nunca lança: falha do store é logada e devolve handled:false", async () => {
    const { bridge, store, publish } = setup();
    await seedSession(store);
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    store.appendMessage = vi.fn(async () => {
      throw new Error("store caiu");
    });

    const result = await bridge.handleWebhook(upsertPayload({ fromMe: true, text: "oi" }));

    expect(result).toEqual({ handled: false });
    expect(publish).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("group-participants.update (leave, não-visitor) → append system message + sessão fechada (fail-safe p/ @lid)", async () => {
    const { bridge, store, publish, client } = setup();
    await seedSession(store);

    const result = await bridge.handleWebhook({
      event: "group-participants.update",
      data: {
        id: GROUP_JID,
        participants: ["5511000000000@s.whatsapp.net"],
        action: "leave",
      },
    });

    expect(result).toEqual({ handled: true });
    expect(store.messages[0]).toMatchObject({ direction: "system", status: "sent" });
    expect(store.messages[0]?.body).toContain("saíram do grupo");
    // Grupos de atendimento têm só plataforma + visitante: qualquer saída encerra
    // a sessão (fail-safe para o formato @lid, onde o telefone não casa com o
    // visitorPhone) — nunca fica sessão zumbi aceitando envios.
    expect(store.sessions[0]?.status).toBe("closed");
    // 2 publishes: mensagem de sistema + evento de session (status closed).
    expect(publish).toHaveBeenCalledTimes(2);
    const sessionEvent = publish.mock.calls.find((c) => c[1]?.type === "session");
    expect(sessionEvent?.[1]).toEqual({ type: "session", status: "closed" });
    expect(client.leaveGroup).toHaveBeenCalledWith(INSTANCE, GROUP_JID);
  });

  it("group-participants.update com participantes @lid (formato novo) → sessão fechada", async () => {
    const { bridge, store } = setup();
    await seedSession(store);

    const result = await bridge.handleWebhook({
      event: "group-participants.update",
      data: {
        id: GROUP_JID,
        participants: [{ id: "50349935210504@lid", phoneNumber: "5585999997777@s.whatsapp.net", admin: null }],
        action: "remove",
      },
    });

    expect(result).toEqual({ handled: true });
    expect(store.sessions[0]?.status).toBe("closed");
  });

  it("group-participants: o próprio visitante sai → sessão fechada (visitor_left) + sai do grupo órfão", async () => {
    const { bridge, store, publish, client } = setup();
    await seedSession(store);

    const result = await bridge.handleWebhook({
      event: "group-participants.update",
      data: {
        id: GROUP_JID,
        participants: [`${VISITOR_PHONE}@s.whatsapp.net`],
        action: "leave",
      },
    });

    expect(result).toEqual({ handled: true });
    expect(store.sessions[0]?.status).toBe("closed");
    // 2 publishes: mensagem de sistema + evento de session (status closed).
    expect(publish).toHaveBeenCalledTimes(2);
    const sessionEvent = publish.mock.calls.find((c) => c[1]?.type === "session");
    expect(sessionEvent?.[1]).toEqual({ type: "session", status: "closed" });
    // Limpeza: empresa sai do grupo na Evolution para não acumular órfãos.
    expect(client.leaveGroup).toHaveBeenCalledWith(INSTANCE, GROUP_JID);
  });

  it("group-participants de grupo desconhecido → handled:true, sem append e sem publish", async () => {
    const { bridge, store, publish } = setup();
    const result = await bridge.handleWebhook({
      event: "group-participants.update",
      data: { id: "120363unknown@g.us", participants: ["5511000000000@s.whatsapp.net"], action: "leave" },
    });
    expect(result).toEqual({ handled: true });
    expect(store.messages).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// typing indicator (PRESENCE_UPDATE + setVisitorTyping)
// ---------------------------------------------------------------------------

describe("ChatBridge typing (presence)", () => {
  it("PRESENCE_UPDATE da DONA (plataforma) → publica typing owner=true", async () => {
    const { bridge, store, publish } = setup();
    await seedSession(store);
    const result = await bridge.handleWebhook({
      event: "PRESENCE_UPDATE",
      data: { id: GROUP_JID, presences: { [PLATFORM_JID]: { presence: "composing" } } },
    });
    expect(result).toEqual({ handled: true });
    const ev = publish.mock.calls.find((c) => c[1]?.type === "typing")?.[1] as
      | { type: "typing"; isTyping: boolean; from: "owner" | "visitor" }
      | undefined;
    expect(ev).toEqual({ type: "typing", isTyping: true, from: "owner" });
  });

  it("PRESENCE_UPDATE do VISITANTE → publica typing from=visitor (não dona)", async () => {
    const { bridge, store, publish } = setup();
    await seedSession(store, { groupJid: GROUP_JID });
    const result = await bridge.handleWebhook({
      event: "PRESENCE_UPDATE",
      data: { id: GROUP_JID, presences: { [VISITOR_JID]: { presence: "composing" } } },
    });
    expect(result).toEqual({ handled: true });
    const ev = publish.mock.calls.find((c) => c[1]?.type === "typing")?.[1] as
      | { type: "typing"; isTyping: boolean; from: "owner" | "visitor" }
      | undefined;
    expect(ev).toEqual({ type: "typing", isTyping: true, from: "visitor" });
  });

  it("PRESENCE_UPDATE paused → isTyping=false", async () => {
    const { bridge, store, publish } = setup();
    await seedSession(store, { groupJid: GROUP_JID });
    await bridge.handleWebhook({
      event: "PRESENCE_UPDATE",
      data: { id: GROUP_JID, presences: { [PLATFORM_JID]: { presence: "paused" } } },
    });
    const ev = publish.mock.calls.find((c) => c[1]?.type === "typing")?.[1] as
      | { type: "typing"; isTyping: boolean; from: "owner" | "visitor" }
      | undefined;
    expect(ev).toEqual({ type: "typing", isTyping: false, from: "owner" });
  });

  it("PRESENCE_UPDATE de grupo desconhecido → handled:false (não é desta plataforma), sem publish", async () => {
    const { bridge, publish } = setup();
    const result = await bridge.handleWebhook({
      event: "PRESENCE_UPDATE",
      data: { id: "120363unknown@g.us", presences: { [PLATFORM_JID]: { presence: "composing" } } },
    });
    expect(result).toEqual({ handled: false });
    expect(publish).not.toHaveBeenCalled();
  });

  it("setVisitorTyping(true) → publica typing visitor=true no canal da sessão", async () => {
    const { bridge, store, publish } = setup();
    await seedSession(store, { realtimeToken: "RT-1" });
    await bridge.setVisitorTyping("RT-1", true);
    expect(publish).toHaveBeenCalledWith("RT-1", { type: "typing", isTyping: true, from: "visitor" });
    await bridge.setVisitorTyping("RT-1", false);
    expect(publish).toHaveBeenCalledWith("RT-1", { type: "typing", isTyping: false, from: "visitor" });
  });

  it("setVisitorTyping com token/estado inválido → best-effort, sem publish", async () => {
    const { bridge, store, publish } = setup();
    await bridge.setVisitorTyping("desconhecido", true);
    expect(publish).not.toHaveBeenCalled();

    await seedSession(store, { realtimeToken: "RT-CLOSED", status: "closed" });
    await bridge.setVisitorTyping("RT-CLOSED", true);
    expect(publish).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

describe("ChatBridge.history", () => {
  it("token desconhecido → sessão null e sem mensagens (null-safe)", async () => {
    const { bridge } = setup();
    expect(await bridge.history("nope")).toEqual({ session: null, messages: [] });
  });

  it("retorna sessão + mensagens; afterIso filtra o que já foi visto", async () => {
    const { bridge, store } = setup();
    const session = await seedSession(store);
    await store.appendMessage({ sessionId: session.id, direction: "visitor", body: "oi" });
    await store.appendMessage({ sessionId: session.id, direction: "owner", body: "olá" });

    const all = await bridge.history("RT-1");
    expect(all.session).toEqual(session);
    expect(all.messages.map((m) => m.body)).toEqual(["oi", "olá"]);

    expect((await bridge.history("RT-1", "1970-01-01T00:00:00.000Z")).messages).toHaveLength(2);
    expect((await bridge.history("RT-1", "2999-01-01T00:00:00.000Z")).messages).toHaveLength(0);
    expect((await bridge.history("RT-1", null)).messages).toHaveLength(2);
  });
});
