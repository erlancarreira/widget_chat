import { describe, it, expect } from "vitest";
import { parseWebhookEvent } from "../../src/api/webhook-parser";

describe("parseWebhookEvent", () => {
  it("parseia messages.upsert com conversation", () => {
    const parsed = parseWebhookEvent({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "120363000@g.us", fromMe: false, id: "W1" },
        message: { conversation: "Olá dono" },
        messageTimestamp: 1700000000,
      },
    });
    expect(parsed.kind).toBe("message");
    if (parsed.kind === "message") {
      expect(parsed.event.waMessageId).toBe("W1");
      expect(parsed.event.jid).toBe("120363000@g.us");
      expect(parsed.event.fromMe).toBe(false);
      expect(parsed.event.text).toBe("Olá dono");
      expect(parsed.event.timestamp).toBe(1700000000);
    }
  });

  it("fromMe true → mensagem do dono no grupo", () => {
    const parsed = parseWebhookEvent({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "120363000@g.us", fromMe: true, id: "W2" },
        message: { conversation: "respondendo" },
      },
    });
    expect(parsed.kind).toBe("message");
    if (parsed.kind === "message") expect(parsed.event.fromMe).toBe(true);
  });

  it("extendedTextMessage também é extraído", () => {
    const parsed = parseWebhookEvent({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "120363000@g.us", fromMe: false, id: "W3" },
        message: { extendedTextMessage: { text: "via extended" } },
      },
    });
    expect(parsed.kind).toBe("message");
    if (parsed.kind === "message") expect(parsed.event.text).toBe("via extended");
  });

  it("sem texto → ignored (conversation vazio)", () => {
    const parsed = parseWebhookEvent({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "120363000@g.us", fromMe: false, id: "W4" },
        message: { conversation: "   " },
      },
    });
    expect(parsed.kind).toBe("ignored");
  });

  it("sem key.id → ignored", () => {
    const parsed = parseWebhookEvent({
      event: "messages.upsert",
      data: { key: { remoteJid: "x@g.us" }, message: { conversation: "oi" } },
    });
    expect(parsed.kind).toBe("ignored");
  });

  it("connection.update → kind connection", () => {
    const parsed = parseWebhookEvent({
      event: "connection.update",
      data: { state: "open" },
    });
    expect(parsed.kind).toBe("connection");
    if (parsed.kind === "connection") expect(parsed.state).toBe("open");
  });

  it("evento desconhecido → ignored", () => {
    const parsed = parseWebhookEvent({ event: "something.else", data: {} });
    expect(parsed.kind).toBe("ignored");
  });

  it("payload sem event → ignored (nunca lança)", () => {
    const parsed = parseWebhookEvent({ data: {} });
    expect(parsed.kind).toBe("ignored");
  });
});
