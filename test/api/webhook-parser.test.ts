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

  it("group-participants.update (leave) → kind group_participants com jids/action", () => {
    const parsed = parseWebhookEvent({
      event: "group-participants.update",
      data: {
        id: "120363000@g.us",
        participants: ["5511999998888@s.whatsapp.net"],
        author: "5511988887777@s.whatsapp.net",
        action: "leave",
      },
    });
    expect(parsed.kind).toBe("group_participants");
    if (parsed.kind === "group_participants") {
      expect(parsed.event.groupJid).toBe("120363000@g.us");
      expect(parsed.event.participants).toEqual(["5511999998888@s.whatsapp.net"]);
      expect(parsed.event.action).toBe("leave");
      expect(parsed.event.author).toBe("5511988887777@s.whatsapp.net");
    }
  });

  it("group-participants.update mapeia action add/remove/promote/demote", () => {
    for (const action of ["add", "remove", "promote", "demote"]) {
      const parsed = parseWebhookEvent({
        event: "group-participants.update",
        data: { id: "g@g.us", participants: ["5511000000000@s.whatsapp.net"], action },
      });
      expect(parsed.kind).toBe("group_participants");
      if (parsed.kind === "group_participants") expect(parsed.event.action).toBe(action);
    }
  });

  it("group-participants sem id/participants → ignored (nunca lança)", () => {
    expect(parseWebhookEvent({ event: "group-participants.update", data: {} }).kind).toBe("ignored");
    expect(
      parseWebhookEvent({ event: "group-participants.update", data: { id: "g@g.us" } }).kind,
    ).toBe("ignored");
    expect(
      parseWebhookEvent({
        event: "group-participants.update",
        data: { id: "g@g.us", participants: "not-an-array" },
      }).kind,
    ).toBe("ignored");
  });

  it("PRESENCE_UPDATE com mapa presences → kind presence com jid/presence", () => {
    const parsed = parseWebhookEvent({
      event: "PRESENCE_UPDATE",
      data: {
        id: "120363000@g.us",
        presences: { "5511999998888@s.whatsapp.net": { presence: "composing" } },
      },
    });
    expect(parsed.kind).toBe("presence");
    if (parsed.kind === "presence") {
      expect(parsed.event.groupJid).toBe("120363000@g.us");
      expect(parsed.event.participantJid).toBe("5511999998888@s.whatsapp.net");
      expect(parsed.event.presence).toBe("composing");
    }
  });

  it("PRESENCE_UPDATE com participant+presence diretos (forma legada)", () => {
    const parsed = parseWebhookEvent({
      event: "PRESENCE_UPDATE",
      data: { id: "5511988887777@s.whatsapp.net", participant: "5511988887777@s.whatsapp.net", presence: "paused" },
    });
    expect(parsed.kind).toBe("presence");
    if (parsed.kind === "presence") {
      expect(parsed.event.participantJid).toBe("5511988887777@s.whatsapp.net");
      // normalizePresence mapeia paused → paused (e available/unavailable também).
      expect(parsed.event.presence).toBe("paused");
    }
  });

  it("PRESENCE_UPDATE sem estado reconhecível → ignored (nunca lança)", () => {
    const parsed = parseWebhookEvent({
      event: "PRESENCE_UPDATE",
      data: { id: "g@g.us", presences: { "5511000000000@s.whatsapp.net": { presence: "banana" } } },
    });
    expect(parsed.kind).toBe("ignored");
  });
});
