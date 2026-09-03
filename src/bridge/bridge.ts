// src/bridge/bridge.ts — orquestração do chat (caso de uso), 100% orientada a portas.
//
// O bridge é o único lugar que compõe as peças: valida entrada, aplica anti-abuso,
// fala com a Evolution (client), persiste (SessionStore) e notifica o widget
// (RealtimeTransport). Nada disso é importado concretamente — tudo entra por `deps`,
// o que o torna testável sem rede e sem banco (ver test/bridge/bridge.test.ts).
//
// O ConversationRouter (Task 5) é construído a partir do próprio store: ele só enxerga
// Pick<SessionStore, "getSessionByGroupJid" | "isEcho">, então não há dependência nova
// para quem monta o bridge.
//
// Convenção de erros: toda falha esperada sai como ChatError com um código de domínio
// (invalid_input / rate_limited / group_create_failed / send_failed / session_not_found /
// session_closed / store_error), preservando o erro original em `cause`. As rotas (Task 8)
// mapeiam esses códigos para status HTTP — `invalid_input` vira 422 de campo (visível ao
// visitante); falhas de infra/config usam `store_error` (500/502), nunca um 422 indevido.

import { ChatError } from "../errors";
import { generateRealtimeToken, generateSessionCode } from "../api/ids";
import { normalizePhone, toWhatsappJid } from "../api/phone";
import { parseWebhookEvent } from "../api/webhook-parser";
import type { EvolutionClient } from "../api/client";
import type { ChatConfig, ChatMessage, ChatSession } from "../types";
import { ConversationRouter } from "./router";
import { formatFirstMessage, formatFollowup } from "./format";
import type { Clock, RealtimeTransport, SessionStore } from "./types";

export interface StartChatInput {
  name: string;
  phone: string;
  message: string;
  contact?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
  honeypot?: string | null;
}

export interface ChatBridgeDeps {
  client: EvolutionClient;
  store: SessionStore;
  transport: RealtimeTransport;
  /** Relógio injetável (testes determinísticos). Default: `() => new Date()`. */
  clock?: Clock;
}

// Limites de entrada (validados aqui, exibidos como 422 pela rota).
const NAME_MIN = 2;
const NAME_MAX = 60;
const MESSAGE_MIN = 1;
const MESSAGE_MAX = 1000;

// Anti-abuso: máx. de sessões abertas pelo mesmo IP dentro da janela.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_SESSIONS = 5;

/** Sessão fake devolvida quando o honeypot é preenchido (nada é persistido). */
function honeypotSession(atIso: string): ChatSession {
  return {
    id: "honeypot",
    code: "XXXX",
    realtimeToken: "",
    visitorName: "",
    visitorPhone: "",
    visitorContact: null,
    groupJid: null,
    status: "closed",
    createdAt: atIso,
    lastMessageAt: null,
  };
}

/** Trim + faixa de tamanho; lança ChatError("invalid_input") nomeando o campo. */
function requireText(value: string, min: number, max: number, field: string): string {
  // `typeof` é defensivo: a rota pode entregar undefined/null vindos de JSON.
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length < min || trimmed.length > max) {
    throw new ChatError(`${field} deve ter entre ${min} e ${max} caracteres`, "invalid_input");
  }
  return trimmed;
}

export class ChatBridge {
  private readonly router: ConversationRouter;
  private readonly clock: Clock;
  private config: ChatConfig | null = null;

  constructor(private readonly deps: ChatBridgeDeps) {
    this.router = new ConversationRouter(deps.store);
    this.clock = deps.clock ?? (() => new Date());
  }

  /** Config injetada pelas rotas a cada request (setConfig → uso → getConfig). */
  getConfig(): ChatConfig {
    if (this.config === null) {
      // F3: config ausente é falha de infraestrutura, não entrada inválida do visitante.
      // `invalid_input` seria mapeado pela Task 8 a um 422 de campo exibido a quem visita.
      throw new ChatError("Chat não configurado", "store_error");
    }
    return this.config;
  }

  setConfig(cfg: ChatConfig): void {
    this.config = cfg;
  }

  /**
   * Abre uma conversa: cria o grupo na Evolution, envia a primeira mensagem e persiste a
   * sessão. Não publica no canal realtime — quem abriu o chat já tem a própria mensagem.
   */
  async startChat(input: StartChatInput): Promise<{ session: ChatSession; messages: ChatMessage[] }> {
    const atIso = this.clock().toISOString();

    // Anti-bot silencioso: campo invisível preenchido → finge sucesso e não toca em nada.
    if (typeof input.honeypot === "string" && input.honeypot.trim().length > 0) {
      return { session: honeypotSession(atIso), messages: [] };
    }

    const name = requireText(input.name, NAME_MIN, NAME_MAX, "Nome");
    const message = requireText(input.message, MESSAGE_MIN, MESSAGE_MAX, "Mensagem");
    const phone = normalizePhone(input.phone); // ChatError("invalid_input") se não for número útil
    const cfg = this.getConfig();
    const store = this.deps.store;

    if (typeof input.ipHash === "string" && input.ipHash !== "") {
      const recent = await store.countRecentSessionsByIpHash(input.ipHash, RATE_LIMIT_WINDOW_MS);
      if (recent >= RATE_LIMIT_MAX_SESSIONS) {
        throw new ChatError(
          `Limite de ${RATE_LIMIT_MAX_SESSIONS} sessões por IP em 10 minutos excedido`,
          "rate_limited",
        );
      }
    }

    const code = generateSessionCode();
    const visitorJid = toWhatsappJid(phone);
    const platformJid = toWhatsappJid(normalizePhone(cfg.platformNumber));
    // visitor == platform (a plataforma se auto-atende) → lista dedupe, uma única chamada.
    const participants = [...new Set([visitorJid, platformJid])];
    const subject = `${cfg.projectName} — ${name} (#${code})`;

    const groupJid = await this.createGroupWithRetry(cfg.instance, subject, participants, platformJid);

    const session = await store.createSession({
      code,
      realtimeToken: generateRealtimeToken(),
      visitorName: name,
      visitorPhone: phone,
      visitorContact: input.contact ?? null,
      groupJid,
      ipHash: input.ipHash ?? null,
      userAgent: input.userAgent ?? null,
    });

    let waMessageId: string;
    try {
      ({ waMessageId } = await this.deps.client.sendText(
        cfg.instance,
        groupJid,
        formatFirstMessage(code, name, message),
      ));
    } catch (error) {
      // Grupo existe, mas a conversa não começou: marca failed para não virar sessão zumbi.
      await store.markStatus(session.id, "failed");
      throw new ChatError("Falha ao enviar a primeira mensagem para o grupo", "send_failed", error);
    }

    // Registra o id antes de qualquer eco chegar do webhook.
    await store.registerSentMessageId(session.id, waMessageId);
    const initial = await store.appendMessage({
      sessionId: session.id,
      direction: "visitor",
      body: message,
      waMessageId,
      status: "sent",
    });

    return { session, messages: [initial] };
  }

  /** Relay site → grupo: persiste pending, envia, promove para sent (ou failed). */
  async sendVisitorMessage(token: string, text: string): Promise<ChatMessage> {
    const cfg = this.getConfig();
    const { store } = this.deps;

    const session = await store.getSessionByToken(token);
    if (session === null) throw new ChatError("Sessão não encontrada", "session_not_found");
    if (session.status !== "active") throw new ChatError("Sessão encerrada", "session_closed");
    const body = requireText(text, MESSAGE_MIN, MESSAGE_MAX, "Mensagem");
    if (session.groupJid === null) throw new ChatError("Sessão sem grupo associado", "send_failed");

    const pending = await store.appendMessage({
      sessionId: session.id,
      direction: "visitor",
      body,
      status: "pending",
    });

    let waMessageId: string;
    try {
      ({ waMessageId } = await this.deps.client.sendText(
        cfg.instance,
        session.groupJid,
        formatFollowup(session.visitorName, body),
      ));
    } catch (error) {
      await store.updateMessageStatus(pending.id, "failed");
      throw new ChatError("Falha ao enviar mensagem para o grupo", "send_failed", error);
    }

    await store.registerSentMessageId(session.id, waMessageId);
    await store.updateMessageStatus(pending.id, "sent");
    await store.touchSession(session.id, this.clock().toISOString());

    // Devolve o estado já promovido (cópia): o chamador não depende de o store mutar ou não
    // a referência que recebeu no appendMessage.
    return { ...pending, status: "sent", waMessageId };
  }

  /**
   * Entrada do webhook da Evolution. NUNCA lança: um 500 aqui faz a Evolution reenviar
   * a mesma mensagem para sempre. Qualquer problema é logado e devolvido como não tratado.
   */
  async handleWebhook(payload: unknown): Promise<{ handled: boolean }> {
    try {
      const parsed = parseWebhookEvent(payload);
      if (parsed.kind !== "message") return { handled: false }; // connection.update / ignored

      const now = this.clock();
      const decision = await this.router.decide(parsed.event, now);
      if (decision.action !== "route") return { handled: false }; // echo / unknown_session / not_text / ignore

      const { session, direction, text } = decision;
      const waMessageId = parsed.event.waMessageId;

      // F2: idempotência de reentrega. A Evolution reenvia a mesma mensagem sempre que
      // devolvemos handled:false (ex.: publish falhou). Sem esta guarda, o reenvio
      // duplicaria append + publish. O isEcho do router continua cobrindo só o eco de
      // mensagens NOSSAS (outbound); aqui é inbound repetido.
      const existing = await this.deps.store.findMessageByWaId(session.id, waMessageId);
      if (existing !== null) return { handled: true }; // já processada: só reconhece

      const message = await this.deps.store.appendMessage({
        sessionId: session.id,
        direction,
        body: text,
        waMessageId,
        status: "sent",
      });
      await this.deps.store.touchSession(session.id, now.toISOString());
      await this.deps.transport.publish(session.realtimeToken, { type: "message", message });
      return { handled: true };
    } catch (error) {
      console.error("[evolution-chat] webhook não processado:", error);
      return { handled: false };
    }
  }

  /** Replay para o widget: sessão por token + mensagens (opcionalmente após um ISO). */
  async history(
    token: string,
    afterIso?: string | null,
  ): Promise<{ session: ChatSession | null; messages: ChatMessage[] }> {
    const session = await this.deps.store.getSessionByToken(token);
    if (session === null) return { session: null, messages: [] };
    const messages = await this.deps.store.listMessages(session.id, afterIso);
    return { session, messages };
  }

  /**
   * createGroup com uma única retratação: um participante inválido (ex.: o número do
   * visitante, vindo de um formulário web) não pode abortar o atendimento — a segunda
   * tentativa cria o grupo só com a plataforma, o número que controlamos e é válido.
   *
   * Atenção (F1): createGroup NÃO é idempotente. Se a 1ª chamada criar o grupo e o erro
   * observado for um timeout, a retratação pode orfanar um segundo grupo; a compensação
   * (limpeza/reconciliação de órfãos) é preocupação das Tasks 7/8, não deste fix.
   */
  private async createGroupWithRetry(
    instance: string,
    subject: string,
    participants: string[],
    platformJid: string,
  ): Promise<string> {
    const attempts: string[][] =
      participants.length > 1 ? [participants, [platformJid]] : [participants];
    let lastError: unknown;

    for (const attempt of attempts) {
      try {
        const { groupJid } = await this.deps.client.createGroup(instance, subject, attempt);
        return groupJid;
      } catch (error) {
        lastError = error;
      }
    }

    throw new ChatError("Falha ao criar o grupo na Evolution", "group_create_failed", lastError);
  }
}
