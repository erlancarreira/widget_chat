// src/bridge/router.ts — SRP: decidir O QUE FAZER com uma mensagem inbound do webhook.
//
// Puro: não persiste, não publica, não chama a Evolution. Recebe o recorte mínimo do
// SessionStore (Pick) e devolve um RouterDecision discriminado; quem executa é a bridge.
//
// Regras (ordem fixada pelo plano):
//   1. jid não termina em "@g.us"            → ignore   (sem tocar no store)
//   2. sem sessão para o groupJid             → unknown_session
//   3. isEcho(sessionId, waMessageId)         → echo     (mensagem enviada por nós)
//   4. sem texto                              → not_text
//   5. caso contrário                         → route, direction = fromMe ? owner : visitor

import type { InboundMessage } from "../types";
import type { ChatMessageDirection } from "../types";
import type { RouterDecision, SessionStore } from "./types";

/** Sufixo que identifica um Jid de grupo no WhatsApp. */
const GROUP_JID_SUFFIX = "@g.us";

export class ConversationRouter {
  constructor(private readonly store: Pick<SessionStore, "getSessionByGroupJid" | "isEcho">) {}

  /**
   * `now` faz parte do contrato para que a bridge propague uma única leitura de relógio
   * por mensagem (touch/close/limite de horário nas próximas tasks); o router puro ainda
   * não a consome.
   */
  async decide(msg: InboundMessage, now: Date): Promise<RouterDecision> {
    void now;

    if (!msg.jid.endsWith(GROUP_JID_SUFFIX)) return { action: "ignore" };

    const session = await this.store.getSessionByGroupJid(msg.jid);
    if (session === null) return { action: "unknown_session" };

    if (await this.store.isEcho(session.id, msg.waMessageId)) return { action: "echo" };

    // `text` é string|null no contrato do parser; a checagem defensiva cobre chamadores JS.
    if (typeof msg.text !== "string" || msg.text.length === 0) return { action: "not_text" };

    const direction: ChatMessageDirection = msg.fromMe ? "owner" : "visitor";
    return { action: "route", session, direction, text: msg.text ?? "" };
  }
}
