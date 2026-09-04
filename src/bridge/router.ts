// src/bridge/router.ts — SRP: decidir O QUE FAZER com uma mensagem inbound do webhook.
//
// Puro: não persiste, não publica, não chama a Evolution. Recebe o recorte mínimo do
// SessionStore (Pick) e devolve um RouterDecision discriminado; quem executa é a bridge.
//
// Regras (modo grupo e modo direto):
//   - jid de grupo (@g.us): sessão por groupJid (comportamento original).
//   - jid pessoal (1:1, modo direto): sessão pelo telefone do visitante.
//   - isEcho(sessionId, waMessageId)       → echo   (mensagem enviada por nós)
//   - sem texto                            → not_text
//   - caso contrário                       → route, direction = fromMe ? owner : visitor

import type { InboundMessage } from "../types";
import type { ChatMessageDirection } from "../types";
import type { RouterDecision, SessionStore } from "./types";

/** Sufixo que identifica um Jid de grupo no WhatsApp. */
const GROUP_JID_SUFFIX = "@g.us";

export class ConversationRouter {
  constructor(
    private readonly store: Pick<
      SessionStore,
      "getSessionByGroupJid" | "getSessionByVisitorPhone" | "isEcho"
    >,
  ) {}

  /**
   * `now` faz parte do contrato para que a bridge propague uma única leitura de relógio
   * por mensagem (touch/close/limite de horário nas próximas tasks); o router puro ainda
   * não a consome.
   */
  async decide(msg: InboundMessage, now: Date): Promise<RouterDecision> {
    void now;

    let session: Awaited<ReturnType<SessionStore["getSessionByGroupJid"]>> = null;
    if (msg.jid.endsWith(GROUP_JID_SUFFIX)) {
      session = await this.store.getSessionByGroupJid(msg.jid);
    } else {
      // Modo direto: o jid da conversa 1:1 é o JID pessoal do visitante (ex.: 5511...@s.whatsapp.net).
      const phone = msg.jid.split("@")[0] ?? "";
      if (phone.length === 0) return { action: "ignore" };
      session = await this.store.getSessionByVisitorPhone(phone);
    }

    if (session === null) return { action: "unknown_session" };

    if (await this.store.isEcho(session.id, msg.waMessageId)) return { action: "echo" };

    // `text` é string|null no contrato do parser; a checagem defensiva cobre chamadores JS.
    if (typeof msg.text !== "string" || msg.text.length === 0) return { action: "not_text" };

    const direction: ChatMessageDirection = msg.fromMe ? "owner" : "visitor";
    return { action: "route", session, direction, text: msg.text ?? "" };
  }
}
