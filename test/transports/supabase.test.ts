// test/transports/supabase.test.ts — adapter Supabase Realtime (broadcast) das portas
// RealtimeTransport (server publica) e RealtimeHandle (widget assina).
//
// Estratégia: nenhum socket real. O `SupabaseClient` do server é um fake cujo `channel()`
// devolve um canal encadeável (`on`/`subscribe` retornam `this`); `createClient` — usado
// pelo handle do widget — é interceptado com vi.mock e devolve exatamente o mesmo tipo de
// fake. As asserções são de COMPORTAMENTO observável: nome do canal, args do `send`,
// payload entregue a `onEvent`, estados reportados a `onStatus` e o `unsubscribe` devolvido.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatEvent } from "../../src/types";
import { createSupabaseRealtimeHandle, createSupabaseTransport, __resetRealtimeClientCache } from "../../src/transports/supabase";

// vi.hoisted: o stub de createClient precisa existir antes do import do módulo sob teste.
const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: createClientMock }));

const SUPABASE_URL = "https://proj.example.supabase.co";
const ANON_KEY = "anon-key";
const TOKEN = "tok-abc123";
const CHANNEL = `chat:${TOKEN}`;

const EVENT: ChatEvent = {
  type: "message",
  message: {
    id: "msg-1",
    sessionId: "ses-1",
    direction: "owner",
    body: "Olá!",
    status: "sent",
    waMessageId: "WA-1",
    createdAt: "2025-03-01T10:00:00.000Z",
  },
};

/** Args aceitos por `channel.send` (subconjunto que exercitamos). */
interface SendArgs {
  type: string;
  event: string;
  payload: unknown;
}

type BroadcastCb = (payload: { type: string; event: string; payload: ChatEvent }) => void;
type StatusCb = (status: string) => void;

interface FakeChannel {
  readonly name: string;
  /** args de todo `send()` recebido, na ordem. */
  readonly sent: SendArgs[];
  /** callbacks registrados via `on("broadcast", …)`, na ordem. */
  readonly handlers: BroadcastCb[];
  /** callbacks de status registrados via `subscribe(cb)`, na ordem. */
  readonly statusHandlers: StatusCb[];
  readonly send: (args: SendArgs) => Promise<string>;
  readonly on: (type: string, filter: { event: string }, cb: BroadcastCb) => FakeChannel;
  readonly subscribe: (cb?: StatusCb) => FakeChannel;
  readonly unsubscribe: () => Promise<string>;
}

function createFakeChannel(name: string): FakeChannel {
  const sent: SendArgs[] = [];
  const handlers: BroadcastCb[] = [];
  const statusHandlers: StatusCb[] = [];

  const send = vi.fn(async (args: SendArgs): Promise<string> => {
    sent.push(args);
    return "ok";
  });
  const unsubscribe = vi.fn(async (): Promise<string> => "ok");
  // Encadeável, como o RealtimeChannel real: on/subscribe devolvem o próprio canal.
  const on = vi.fn((_type: string, _filter: { event: string }, cb: BroadcastCb): FakeChannel => {
    handlers.push(cb);
    return channel;
  });
  const subscribe = vi.fn((cb?: StatusCb): FakeChannel => {
    if (cb !== undefined) {
      statusHandlers.push(cb);
      cb("SUBSCRIBED"); // handshake bem-sucedido reportado imediatamente
    }
    return channel;
  });

  const channel: FakeChannel = { name, sent, handlers, statusHandlers, send, on, subscribe, unsubscribe };
  return channel;
}

interface FakeClient {
  readonly channels: FakeChannel[];
  readonly channel: (name: string) => FakeChannel;
}

/** SupabaseClient mínimo: só `channel()` é exercitado pelo adapter. */
function createFakeClient(): FakeClient & { client: SupabaseClient } {
  const channels: FakeChannel[] = [];
  const channel = vi.fn((name: string): FakeChannel => {
    const created = createFakeChannel(name);
    channels.push(created);
    return created;
  });
  const fake = { channels, channel };
  return { ...fake, client: fake as unknown as SupabaseClient };
}

/** Client cujo `channel()` devolve um canal com `send` customizado (falhas/rejeições). */
function clientWithSend(send: (args: SendArgs) => Promise<string>): SupabaseClient {
  const channel = vi.fn((name: string) => ({ ...createFakeChannel(name), send }));
  return { channel } as unknown as SupabaseClient;
}

/** Último canal criado pelo fake (o único, na maioria dos testes). */
function lastChannel(channels: FakeChannel[]): FakeChannel {
  const found = channels.at(-1);
  if (found === undefined) throw new Error("nenhum canal foi criado");
  return found;
}

beforeEach(() => {
  createClientMock.mockReset();
  __resetRealtimeClientCache();
});

// ---------------------------------------------------------------------------
// createSupabaseTransport — lado SERVER (publica no canal da sessão)
// ---------------------------------------------------------------------------

describe("createSupabaseTransport", () => {
  it("publica o evento como broadcast {event:'chat'} no canal chat:<token>", async () => {
    const { channels, client } = createFakeClient();
    const transport = createSupabaseTransport(client);

    await transport.publish(TOKEN, EVENT);

    expect(channels).toHaveLength(1);
    const ch = lastChannel(channels);
    expect(ch.name).toBe(CHANNEL);
    expect(ch.sent).toEqual([{ type: "broadcast", event: "chat", payload: EVENT }]);
    expect(ch.send).toHaveBeenCalledTimes(1);
  });

  it("abre um canal por publish (sem estado entre chamadas)", async () => {
    const { channels, client } = createFakeClient();
    const transport = createSupabaseTransport(client);

    await transport.publish(TOKEN, { type: "session", status: "closed" });
    await transport.publish("outro-token", EVENT);

    expect(channels.map((c) => c.name)).toEqual([CHANNEL, "chat:outro-token"]);
    expect(channels[0]?.sent[0]?.payload).toEqual({ type: "session", status: "closed" });
    expect(channels[1]?.sent[0]?.payload).toEqual(EVENT);
  });

  it("aguarda o send completar antes de resolver", async () => {
    let settled = false;
    const client = clientWithSend(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      settled = true;
      return "ok";
    });
    const transport = createSupabaseTransport(client);

    const published = transport.publish(TOKEN, EVENT);
    expect(settled).toBe(false);
    await published;
    expect(settled).toBe(true);
  });

  it("rejeita quando o broadcast não é aceito (webhook precisa devolver handled:false)", async () => {
    const transport = createSupabaseTransport(clientWithSend(async () => "timed out"));

    await expect(transport.publish(TOKEN, EVENT)).rejects.toThrow(/timed out/);
  });

  it("propaga a exceção do send", async () => {
    const transport = createSupabaseTransport(
      clientWithSend(async () => {
        throw new Error("socket fechado");
      }),
    );

    await expect(transport.publish(TOKEN, EVENT)).rejects.toThrow("socket fechado");
  });
});

// ---------------------------------------------------------------------------
// createSupabaseRealtimeHandle — lado WIDGET (assina o canal da sessão)
// ---------------------------------------------------------------------------

describe("createSupabaseRealtimeHandle", () => {
  it("cria o client com url + anonKey e assina o canal chat:<token>", () => {
    const { channels, client } = createFakeClient();
    createClientMock.mockReturnValue(client);
    const handle = createSupabaseRealtimeHandle(SUPABASE_URL, ANON_KEY);

    expect(createClientMock).toHaveBeenCalledWith(SUPABASE_URL, ANON_KEY, expect.any(Object));

    handle.subscribe(TOKEN, vi.fn(), vi.fn());

    const ch = lastChannel(channels);
    expect(ch.name).toBe(CHANNEL);
    expect(ch.on).toHaveBeenCalledWith("broadcast", { event: "chat" }, expect.any(Function));
    expect(ch.subscribe).toHaveBeenCalledTimes(1);
  });

  it("encaminha o payload do broadcast para onEvent", () => {
    const { channels, client } = createFakeClient();
    createClientMock.mockReturnValue(client);
    const handle = createSupabaseRealtimeHandle(SUPABASE_URL, ANON_KEY);
    const onEvent = vi.fn();

    handle.subscribe(TOKEN, onEvent);
    lastChannel(channels).handlers[0]?.({ type: "broadcast", event: "chat", payload: EVENT });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(EVENT);
  });

  it("reporta SUBSCRIBED como open e CHANNEL_ERROR/TIMED_OUT/CLOSED como closed", () => {
    const { channels, client } = createFakeClient();
    createClientMock.mockReturnValue(client);
    const handle = createSupabaseRealtimeHandle(SUPABASE_URL, ANON_KEY);
    const onStatus = vi.fn();

    handle.subscribe(TOKEN, vi.fn(), onStatus);
    const ch = lastChannel(channels);
    // O fake dispara SUBSCRIBED dentro de subscribe() — o callback já rodou.
    expect(onStatus).toHaveBeenLastCalledWith("open");

    ch.statusHandlers[0]?.("CHANNEL_ERROR");
    expect(onStatus).toHaveBeenLastCalledWith("closed");

    ch.statusHandlers[0]?.("TIMED_OUT");
    expect(onStatus).toHaveBeenLastCalledWith("closed");

    ch.statusHandlers[0]?.("CLOSED");
    expect(onStatus).toHaveBeenLastCalledWith("closed");

    ch.statusHandlers[0]?.("SUBSCRIBED"); // reconexão
    expect(onStatus).toHaveBeenLastCalledWith("open");
  });

  it("funciona sem onStatus (opcional)", () => {
    const { channels, client } = createFakeClient();
    createClientMock.mockReturnValue(client);
    const handle = createSupabaseRealtimeHandle(SUPABASE_URL, ANON_KEY);
    const onEvent = vi.fn();

    expect(() => handle.subscribe(TOKEN, onEvent)).not.toThrow();
    lastChannel(channels).handlers[0]?.({ type: "broadcast", event: "chat", payload: EVENT });
    expect(onEvent).toHaveBeenCalledWith(EVENT);
  });

  it("o unsubscribe devolvido deixa o canal", () => {
    const { channels, client } = createFakeClient();
    createClientMock.mockReturnValue(client);
    const handle = createSupabaseRealtimeHandle(SUPABASE_URL, ANON_KEY);

    const unsubscribe = handle.subscribe(TOKEN, vi.fn(), vi.fn());
    const ch = lastChannel(channels);
    expect(ch.unsubscribe).not.toHaveBeenCalled();

    unsubscribe();
    expect(ch.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("cada subscribe cria um canal próprio (sessões distintas)", () => {
    const { channels, client } = createFakeClient();
    createClientMock.mockReturnValue(client);
    const handle = createSupabaseRealtimeHandle(SUPABASE_URL, ANON_KEY);

    handle.subscribe(TOKEN, vi.fn());
    handle.subscribe("tok-2", vi.fn());

    expect(channels.map((c) => c.name)).toEqual([CHANNEL, "chat:tok-2"]);
  });
});
