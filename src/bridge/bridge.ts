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
import { type EvolutionClient } from "../api/client";
import type {
  ChatConfig,
  ChatMessage,
  ChatSession,
  GroupParticipantChange,
  PresenceChange,
} from "../types";
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

/**
 * Detecta erro da Evolution que indica que o destino sumiu: grupo apagado/saiu,
 * participante removido, número bloqueado, etc. Usado para encerrar a sessão com
 * aviso em vez de deixar o composer travado num envio que nunca chega.
 * Sinais: status 404/410 (grupo inexistente / não é participante) ou palavras-chave
 * no corpo/mensagem da resposta.
 */
function isTargetGoneError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  if (status === 404 || status === 410) return true;
  const text = `${String((error as { message?: unknown }).message ?? "")} ${String(
    (error as { body?: unknown }).body ?? "",
  )}`.toLowerCase();
  return /group|participant|recipient|not found|unavailable|left|deleted|blocked|gone/.test(text);
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

    // Reusa a conversa ativa do mesmo visitante (um grupo/thread por cliente) em vez de
    // abrir um grupo novo a cada reabertura — evita a proliferação de grupos no WhatsApp.
    // Só reaproveita se a sessão estiver ativa; se o grupo sumiu no WhatsApp (visitante
    // saiu/apagou), encerramos a sessão antiga e deixamos o fluxo abaixo recriar um grupo
    // novo para o mesmo visitante (auto-recuperação — sem grupo zumbi preso no histórico).
    const existing = await store.getSessionByVisitorPhone(phone);
    if (existing !== null && existing.status === "active") {
      const firstTarget =
        existing.groupJid === null
          ? toWhatsappJid(normalizePhone(cfg.platformNumber))
          : existing.groupJid;
      try {
        const { waMessageId } = await this.deps.client.sendText(
          cfg.instance,
          firstTarget,
          formatFirstMessage(existing.code, name, message),
        );
        await store.registerSentMessageId(existing.id, waMessageId);
        const initial = await store.appendMessage({
          sessionId: existing.id,
          direction: "visitor",
          body: message,
          waMessageId,
          status: "sent",
        });
        return { session: existing, messages: [initial] };
      } catch (error) {
        if (isTargetGoneError(error)) {
          // Grupo apagado/saído: encerra a sessão antiga e recria um grupo novo abaixo.
          await this.closeSessionCleanup(existing, "send_target_gone");
        } else {
          await store.markStatus(existing.id, "failed");
          throw new ChatError("Falha ao enviar a primeira mensagem para o grupo", "send_failed", error);
        }
      }
    }

    const code = generateSessionCode();
    const visitorJid = toWhatsappJid(phone);
    const platformJid = toWhatsappJid(normalizePhone(cfg.platformNumber));
    // visitor == platform (a plataforma se auto-atende) → lista dedupe, uma única chamada.
    const participants = [...new Set([visitorJid, platformJid])];
    const subject = `${cfg.projectName} — ${name} (#${code})`;
    const direct = cfg.createGroup === false;

    let groupJid: string | null = null;
    if (!direct) {
      groupJid = await this.createGroupWithRetry(cfg.instance, subject, participants, platformJid);
      // Imagem de capa do grupo (logo do site / upload do painel). Cosmético: falha não aborta.
      const picture = (cfg.groupImage ?? "").trim();
      if (picture !== "") {
        try {
          await this.deps.client.setGroupPicture(cfg.instance, groupJid, picture);
        } catch {
          // ignora falha de imagem — o atendimento segue sem a capa.
        }
      }
    }

    const session = await store.createSession({
      code,
      realtimeToken: generateRealtimeToken(),
      visitorName: name,
      visitorPhone: phone,
      visitorContact: input.contact ?? null,
      groupJid,
      mode: direct ? "direct" : "group",
      ipHash: input.ipHash ?? null,
      userAgent: input.userAgent ?? null,
    });

    // Em modo direto a conversa é 1:1 com a plataforma; senão, vai para o grupo.
    let firstTarget: string;
    if (direct) {
      firstTarget = platformJid;
    } else {
      if (groupJid === null) throw new ChatError("Falha ao criar o grupo", "group_create_failed");
      firstTarget = groupJid;
    }

    let waMessageId: string;
    try {
      ({ waMessageId } = await this.deps.client.sendText(
        cfg.instance,
        firstTarget,
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

    // Destino: grupo (modo grupo) ou número da plataforma (modo direto 1:1, groupJid nulo).
    let target: string;
    if (session.groupJid === null) {
      target = toWhatsappJid(normalizePhone(cfg.platformNumber));
    } else {
      target = session.groupJid;
    }

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
        target,
        formatFollowup(session.visitorName, body),
      ));
    } catch (error) {
      await store.updateMessageStatus(pending.id, "failed");
      // Se o destino sumiu (grupo saiu/apagado, número bloqueado), encerra a sessão com
      // aviso claro e sai do grupo órfão (best-effort) em vez de deixar o composer travado.
      if (isTargetGoneError(error)) {
        await this.closeSessionCleanup(session, "send_target_gone", {
          systemMessage:
            "Não foi possível entregar a mensagem: o grupo não está mais disponível. Conversa encerrada — inicie uma nova para continuar.",
        });
      }
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
      if (parsed.kind === "group_participants") {
        return await this.handleGroupParticipants(parsed.event);
      }
      if (parsed.kind === "presence") {
        return await this.handlePresence(parsed.event);
      }
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

  /**
   * Trata `group-participants.update` (Evolution): quando alguém entra, sai ou é
   * removido do grupo da sessão, registra uma mensagem de sistema no chat (visível
   * para visitante e time) e, se quem saiu foi o próprio visitante, encerra a sessão
   * — a conversa 1:1 pelo WhatsApp não chega mais pelo grupo.
   * NUNCA lança: qualquer erro é logado e devolvido como tratado (200) para a Evolution
   * não reenviar.
   */
  private async handleGroupParticipants(
    change: GroupParticipantChange,
  ): Promise<{ handled: boolean }> {
    try {
      const session = await this.deps.store.getSessionByGroupJid(change.groupJid);
      if (session === null) return { handled: true }; // grupo não é desta plataforma

      const phones = change.participants.map((jid) => jid.split("@")[0] ?? jid);
      const visitorLeft = change.participants.some((jid) => {
        const phone = jid.split("@")[0] ?? "";
        return phone !== "" && phone === session.visitorPhone;
      });

      let body: string;
      switch (change.action) {
        case "leave":
          body = `Participante(s) saíram do grupo: ${phones.join(", ")}`;
          break;
        case "remove":
          body = `Participante(s) removido(s) do grupo: ${phones.join(", ")}`;
          break;
        case "add":
          body = `Participante(s) adicionado(s) ao grupo: ${phones.join(", ")}`;
          break;
        case "promote":
          body = `Participante(s) promovido(s) a admin: ${phones.join(", ")}`;
          break;
        case "demote":
          body = `Participante(s) rebaixado(s) de admin: ${phones.join(", ")}`;
          break;
        default:
          body = `Alteração de participantes no grupo: ${phones.join(", ")}`;
      }

      const now = this.clock().toISOString();
      const message = await this.deps.store.appendMessage({
        sessionId: session.id,
        direction: "system",
        body,
        status: "sent",
      });
      await this.deps.store.touchSession(session.id, now);
      await this.deps.transport.publish(session.realtimeToken, { type: "message", message });

      // Grupos de atendimento têm só plataforma + visitante. Com JIDs @lid o
      // telefone não dá para comparar (o LID não casa com visitorPhone), então a
      // comparação exata deixa de ser confiável. Fail-safe: qualquer leave/remove
      // encerra a sessão — no pior caso (saída estranha de terceiro) o visitante
      // reabre uma nova conversa; nunca fica com sessão zumbi aceitando envios.
      const left = change.action === "leave" || change.action === "remove";
      if (left || visitorLeft) {
        await this.closeSessionCleanup(session, "visitor_left");
      }

      return { handled: true };
    } catch (error) {
      console.error("[evolution-chat] group-participants não processado:", error);
      return { handled: true };
    }
  }

  /**
   * Trata `PRESENCE_UPDATE` (Evolution): quando a OUTRA ponta está digitando, publica
   * um evento de tempo real para o widget exibir os "3 pontinhos". O `from` distingue
   * quem digita (dona da plataforma vs. visitante) para o widget mostrar só quando a
   * ponta OPOSTA digita.
   * NUNCA lança: erros são logados e devolvidos como tratado (200) para a Evolution não
   * reenviar.
   */
  private async handlePresence(event: PresenceChange): Promise<{ handled: boolean }> {
    try {
      const cfg = this.getConfig();
      if (!cfg.enabled) return { handled: false };

      const session =
        event.groupJid !== null ? await this.deps.store.getSessionByGroupJid(event.groupJid) : null;
      if (session === null || session.status !== "active") return { handled: false };

      const isTyping = event.presence === "composing" || event.presence === "recording";
      // Em grupo a presença vem de um participante específico; em direto (1:1) costuma
      // vir sem `participant` porque a própria conta da plataforma é a conversa.
      // "owner" = a dona da plataforma (a conta conectada à instância) está digitando.
      const from: "owner" | "visitor" = this.isPlatformParticipant(event.participantJid, cfg)
        ? "owner"
        : "visitor";

      await this.deps.transport.publish(session.realtimeToken, { type: "typing", isTyping, from });
      return { handled: true };
    } catch (error) {
      console.error("[evolution-chat] presence não processado:", error);
      return { handled: true };
    }
  }

  /**
   * Sinaliza que o visitante está (ou parou de) digitar no widget. Publica um evento
   * `typing` no canal em tempo real da sessão para que uma eventual INTERFACE DE
   * ATENDENTE exiba o indicador.
   *
   * NOTA sobre WhatsApp: a Evolution só permite anunciar a presença da CONTA CONECTADA
   * à instância. Como o atendente desta plataforma OPERA a própria instância, enviar
   * `sendPresence` faria o widget exibir um "digitando" FALSO do atendente (eco do
   * próprio evento de volta pelo webhook). Por isso, aqui, apenas publicamos no canal
   * em tempo real — a presença WhatsApp do visitante não é representável por terceiros.
   */
  async setVisitorTyping(token: string, isTyping: boolean): Promise<void> {
    try {
      const session = await this.deps.store.getSessionByToken(token);
      if (session === null || session.status !== "active") return; // best-effort

      await this.deps.transport.publish(session.realtimeToken, {
        type: "typing",
        isTyping,
        from: "visitor",
      });
    } catch (error) {
      // Digitando é best-effort: nunca deve quebrar o envio de mensagens.
      console.warn("[evolution-chat] falha ao publicar presença do visitante (ignorado):", error);
    }
  }

  /** Verdadeiro se `jid` é a conta da plataforma (dona da instância). */
  private isPlatformParticipant(jid: string | null, cfg: ChatConfig): boolean {
    if (jid === null) return true; // modo direto: a conversa é a própria plataforma
    // Compara só os dígitos do participant contra o número da plataforma
    // normalizado — resiste a variações de JID (+55..., @s.whatsapp.net, etc).
    const participant = (jid.split("@")[0] ?? "").replace(/\D/g, "");
    const platform = normalizePhone(cfg.platformNumber);
    return participant === platform;
  }

  /**
   * Encerra a sessão (status closed + evento realtime) e — só quando o grupo morreu do
   * lado do visitante (ele saiu ou o destino sumiu) — faz a EMPRESA SAIR do grupo na
   * Evolution (best-effort) para não acumular grupos órfãos. Em fechamentos normais
   * (atendente encerrou a conversa) NÃO saímos: senão o visitante ficaria sozinho no grupo.
   */
  private async closeSessionCleanup(
    session: ChatSession,
    reason: string,
    opts: { systemMessage?: string } = {},
  ): Promise<void> {
    const now = this.clock().toISOString();
    await this.deps.store.markStatus(session.id, "closed", reason);
    await this.deps.store.touchSession(session.id, now);

    if (opts.systemMessage !== undefined) {
      const notice = await this.deps.store.appendMessage({
        sessionId: session.id,
        direction: "system",
        body: opts.systemMessage,
        status: "sent",
      });
      await this.deps.transport.publish(session.realtimeToken, { type: "message", message: notice });
    }

    await this.deps.transport.publish(session.realtimeToken, { type: "session", status: "closed" });

    if (
      session.groupJid !== null &&
      (reason === "visitor_left" || reason === "send_target_gone")
    ) {
      try {
        await this.deps.client.leaveGroup(this.getConfig().instance, session.groupJid);
      } catch (error) {
        console.error("[evolution-chat] falha ao sair do grupo órfão:", error);
      }
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
