import { describe, expect, it } from "vitest";
import { parseWebhookEvent } from "../src/api/webhook-parser";

const upsert = {
  event: "messages.upsert", instance: "erlan", instanceId: "1", server_url: "", hash: "", sender: "", destination: "",
  data: {
    key: { remoteJid: "120363-abc@g.us", fromMe: true, id: "3EB0ABC", participant: "5511999998888@s.whatsapp.net" },
    pushName: "Erlan", status: "PENDING",
    message: { extendedTextMessage: { text: "  Resposta do dono  " } },
    messageType: "conversation", messageTimestamp: 1725400000, source: "android",
  },
};

describe("parseWebhookEvent", () => {
  it("normaliza messages.upsert e faz trim do texto", () => {
    const r = parseWebhookEvent(upsert);
    expect(r.kind).toBe("message");
    if (r.kind === "message") {
      expect(r.event.text).toBe("Resposta do dono");
      expect(r.event.jid).toBe("120363-abc@g.us");
      expect(r.event.fromMe).toBe(true);
      expect(r.event.senderJid).toBe("5511999998888@s.whatsapp.net");
    }
  });
  it("aceita data em array (v2)", () => {
    const r = parseWebhookEvent({ ...upsert, data: [upsert.data] });
    expect(r.kind).toBe("message");
  });
  it("array com item inválido antes do válido → devolve o primeiro válido (sem drop silencioso)", () => {
    const r = parseWebhookEvent({ ...upsert, data: [null, upsert.data] });
    expect(r.kind).toBe("message");
    if (r.kind === "message") {
      expect(r.event.waMessageId).toBe("3EB0ABC");
      expect(r.event.jid).toBe("120363-abc@g.us");
    }
  });
  it("array com mensagem sem key antes da boa → devolve a boa", () => {
    const semKey = { key: null, message: { conversation: "sem id" }, messageTimestamp: 1725400000 };
    const r = parseWebhookEvent({ ...upsert, data: [semKey, upsert.data] });
    expect(r.kind).toBe("message");
    if (r.kind === "message") {
      expect(r.event.waMessageId).toBe("3EB0ABC");
      expect(r.event.text).toBe("Resposta do dono");
      expect(r.event.fromMe).toBe(true);
      expect(r.event.raw).toBe(upsert.data);
    }
  });
  it("array onde nenhum item é válido → ignored", () => {
    const semKey = { key: null, message: { conversation: "sem id" } };
    expect(parseWebhookEvent({ ...upsert, data: [] })).toMatchObject({ kind: "ignored" });
    expect(parseWebhookEvent({ ...upsert, data: [null, semKey] })).toMatchObject({ kind: "ignored" });
  });
  it("data não-array continua valendo (objeto único, null, string)", () => {
    expect(parseWebhookEvent(upsert).kind).toBe("message");
    expect(parseWebhookEvent({ ...upsert, data: null })).toMatchObject({ kind: "ignored" });
    expect(parseWebhookEvent({ ...upsert, data: "lixo" })).toMatchObject({ kind: "ignored" });
  });
  it("ignora mensagem sem texto", () => {
    const noText = { ...upsert, data: { ...upsert.data, message: { imageMessage: { caption: "" } }, messageType: "imageMessage" } };
    expect(parseWebhookEvent(noText)).toMatchObject({ kind: "ignored" });
  });
  it("ignora evento desconhecido e trata connection.update", () => {
    expect(parseWebhookEvent({ event: "chats.upsert", data: [] })).toMatchObject({ kind: "ignored" });
    expect(parseWebhookEvent({ event: "connection.update", data: { state: "open" } })).toEqual({ kind: "connection", state: "open" });
  });
  it("payload inválido → ignored (nunca throw)", () => {
    expect(parseWebhookEvent(null)).toMatchObject({ kind: "ignored" });
    expect(parseWebhookEvent("lixo")).toMatchObject({ kind: "ignored" });
  });
});
