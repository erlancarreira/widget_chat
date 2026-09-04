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

  it("group-participants.update com participantes objeto (@lid, WhatsApp novo) → normaliza pelo phoneNumber", () => {
    const parsed = parseWebhookEvent({
      event: "group-participants.update",
      data: {
        id: "120363431049084020@g.us",
        participants: [{ id: "50349935210504@lid", phoneNumber: "558588855793@s.whatsapp.net", admin: null }],
        action: "remove",
        author: "50349935210504@lid",
      },
    });
    expect(parsed.kind).toBe("group_participants");
    if (parsed.kind === "group_participants") {
      expect(parsed.event.participants).toEqual(["558588855793@s.whatsapp.net"]);
    }
  });

  it("group-participants.update objeto sem phoneNumber → usa id; misto string+objeto aceito", () => {
    const parsed = parseWebhookEvent({
      event: "group-participants.update",
      data: {
        id: "g@g.us",
        participants: [{ id: "50349935210504@lid", admin: null }, "5511000000000@s.whatsapp.net"],
        action: "leave",
      },
    });
    expect(parsed.kind).toBe("group_participants");
    if (parsed.kind === "group_participants") {
      expect(parsed.event.participants).toEqual(["50349935210504@lid", "5511000000000@s.whatsapp.net"]);
    }
  });

  it("normaliza o nome do evento entre variações da Evolution (MESSAGES_UPSERT, messages-upsert)", () => {
    const data = { key: { id: "M1", remoteJid: "g@g.us" }, message: { conversation: "oi" } };
    for (const event of ["MESSAGES_UPSERT", "messages.upsert", "messages-upsert", "Messages.Upsert"]) {
      const parsed = parseWebhookEvent({ event, data });
      expect(parsed.kind).toBe("message");
    }
    for (const event of ["GROUP-PARTICIPANTS.UPDATE", "GROUP_PARTICIPANTS_UPDATE"]) {
      const parsed = parseWebhookEvent({
        event,
        data: { id: "g@g.us", participants: ["5511000000000@s.whatsapp.net"], action: "leave" },
      });
      expect(parsed.kind).toBe("group_participants");
    }
    const presence = parseWebhookEvent({
      event: "presence-update",
      data: { id: "g@g.us", participant: "5511999998888@s.whatsapp.net", presence: "composing" },
    });
    expect(presence.kind).toBe("presence");
  });

  it("legenda de mídia (imageMessage/videoMessage/documentMessage) conta como texto", () => {
    const parsed = parseWebhookEvent({
      event: "messages.upsert",
      data: {
        key: { id: "M2", remoteJid: "g@g.us", participant: "5511999998888@s.whatsapp.net" },
        message: { imageMessage: { caption: "olha isso ", url: "https://x/y.jpg" } },
      },
    });
    expect(parsed.kind).toBe("message");
    if (parsed.kind === "message") {
      expect(parsed.event.text).toBe("olha isso");
      expect(parsed.event.senderJid).toBe("5511999998888@s.whatsapp.net");
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
