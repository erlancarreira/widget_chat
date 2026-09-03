import { describe, expect, it } from "vitest";
import { ConversationRouter } from "../../src/bridge/router";
import type { SessionStore } from "../../src/bridge/types";
import type { ChatSession } from "../../src/types";
import type { InboundMessage } from "../../src/api/webhook-parser";

const GROUP_A = "120363aaaa@g.us";
const GROUP_B = "120363bbbb@g.us";

function session(id: string, groupJid: string): ChatSession {
  return {
    id,
    code: id === "s-1" ? "A3F2" : "B7C1",
    realtimeToken: `rt-${id}`,
    visitorName: "João",
    visitorPhone: "5511999999999",
    visitorContact: null,
    groupJid,
    status: "active",
    createdAt: "2025-01-01T00:00:00.000Z",
    lastMessageAt: null,
  };
}

// Fake in-memory: só as duas portas que o router enxerga (Pick<SessionStore, ...>).
// Registra chamadas para pinar que `ignore` não consulta o store e que `isEcho`
// recebe (sessionId, waMessageId) — não só o id da mensagem.
function makeStore(sessions: ChatSession[], echoIds: string[] = []) {
  const echo = new Set(echoIds);
  const calls: { getSessionByGroupJid: string[]; isEcho: [string, string][] } = {
    getSessionByGroupJid: [],
    isEcho: [],
  };
  const store: Pick<SessionStore, "getSessionByGroupJid" | "isEcho"> = {
    async getSessionByGroupJid(jid) {
      calls.getSessionByGroupJid.push(jid);
      return sessions.find((s) => s.groupJid === jid) ?? null;
    },
    async isEcho(sessionId, waMessageId) {
      calls.isEcho.push([sessionId, waMessageId]);
      return echo.has(`${sessionId}:${waMessageId}`);
    },
  };
  return { store, calls };
}

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    waMessageId: "MSG-1",
    jid: GROUP_A,
    fromMe: false,
    senderJid: "5511999998888@s.whatsapp.net",
    text: "oi",
    timestamp: 1725400000,
    raw: {},
    ...over,
  };
}

const NOW = new Date("2025-01-02T03:04:05.000Z");

describe("ConversationRouter.decide", () => {
  const sessions = [session("s-1", GROUP_A), session("s-2", GROUP_B)];

  it("fromMe=true em grupo conhecido → route/owner com sessão e texto", async () => {
    const { store, calls } = makeStore(sessions);
    const d = await new ConversationRouter(store).decide(inbound({ fromMe: true, text: "Resposta do dono" }), NOW);
    expect(d).toEqual({
      action: "route",
      session: sessions[0],
      direction: "owner",
      text: "Resposta do dono",
    });
    expect(calls.getSessionByGroupJid).toEqual([GROUP_A]);
  });

  it("fromMe=false em grupo conhecido → route/visitor", async () => {
    const { store } = makeStore(sessions);
    const d = await new ConversationRouter(store).decide(inbound({ jid: GROUP_B, fromMe: false, text: "oi" }), NOW);
    expect(d.action).toBe("route");
    expect(d.direction).toBe("visitor");
    expect(d.session?.id).toBe("s-2");
    expect(d.text).toBe("oi");
  });

  it("isEcho → echo (sem sessão/direção/texto no resultado)", async () => {
    const { store, calls } = makeStore(sessions, ["s-1:MSG-1"]);
    const d = await new ConversationRouter(store).decide(inbound({ fromMe: true }), NOW);
    expect(d).toEqual({ action: "echo" });
    expect(calls.isEcho).toEqual([["s-1", "MSG-1"]]);
  });

  it("echo vence not_text (ordem das regras do plano)", async () => {
    const { store } = makeStore(sessions, ["s-1:MSG-1"]);
    const d = await new ConversationRouter(store).decide(inbound({ text: null }), NOW);
    expect(d.action).toBe("echo");
  });

  it("grupo sem sessão → unknown_session (e não consulta isEcho)", async () => {
    const { store, calls } = makeStore(sessions);
    const d = await new ConversationRouter(store).decide(inbound({ jid: "120363zzzz@g.us" }), NOW);
    expect(d).toEqual({ action: "unknown_session" });
    expect(calls.isEcho).toEqual([]);
  });

  it("texto ausente → not_text", async () => {
    const { store } = makeStore(sessions);
    const d = await new ConversationRouter(store).decide(inbound({ text: null }), NOW);
    expect(d).toEqual({ action: "not_text" });
  });

  it("jid que não termina em @g.us → ignore sem tocar no store", async () => {
    const { store, calls } = makeStore(sessions);
    const d = await new ConversationRouter(store).decide(inbound({ jid: "5511999999999@s.whatsapp.net" }), NOW);
    expect(d).toEqual({ action: "ignore" });
    expect(calls.getSessionByGroupJid).toEqual([]);
    expect(calls.isEcho).toEqual([]);
  });

  it("só o SUFIXO @g.us conta como grupo (não basta conter)", async () => {
    const { store, calls } = makeStore(sessions);
    const router = new ConversationRouter(store);
    const naoGrupo = [
      "status@broadcast",
      "g.us",
      "5511999999999@s.whatsapp.net",
      "120363abc@g.us.invalid", // contém @g.us, mas não termina nele
    ];
    for (const jid of naoGrupo) {
      const d = await router.decide(inbound({ jid }), NOW);
      expect(d, `jid=${jid}`).toEqual({ action: "ignore" });
    }
    expect(calls.getSessionByGroupJid).toEqual([]);
  });

  it("sessão conhecida por outro grupo não vaza na decisão", async () => {
    const { store } = makeStore(sessions);
    const d = await new ConversationRouter(store).decide(inbound({ jid: GROUP_B }), NOW);
    expect(d.session?.id).toBe("s-2");
  });
});
