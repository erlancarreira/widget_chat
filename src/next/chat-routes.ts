// src/next/chat-routes.ts — factories de rotas para o App Router do Next, SEM importar "next".
//
// O plano proíbe dependência de "next"/"next/server": o App Router aceita os handlers
// padrão Web `Request → Promise<Response>`, então as fábricas devolvem funções puras e o
// arquivo de rota do consumidor apenas encaminha. Padrão de uso no LMS
// (app/api/chat/route.ts):
//
//   import { createChatRoutes } from "@erlancarreira/evolution-chat/next";
//   const handlers = createChatRoutes(deps);
//   export const GET = (req: Request) => handlers.GET(req);
//   export const POST = (req: Request) => handlers.POST(req);
//
// e em app/api/chat/webhook/route.ts:
//
//   import { createWebhookRoute } from "@erlancarreira/evolution-chat/next";
//   const webhook = createWebhookRoute({ bridge, getConfig });
//   export const POST = (req: Request) => webhook.POST(req);
//
// Mapeamento ChatError.code → HTTP (contrato da Task 8):
//   invalid_input → 422 {error, field?}   rate_limited → 429 {error}
//   session_not_found → 404               session_closed → 409
//   group_create_failed / send_failed → 502 {error}
//   store_error → 502                     inesperado → 500 (log server-side)
//
// O mapeamento lê o `code` por DUCK-TYPING, nunca por `instanceof ChatError`. Motivo:
// o tsup emite uma cópia própria de `ChatError` em CADA bundle de entry (sem shared
// chunks), então a classe que vive no bundle /bridge NÃO é a mesma do bundle /next —
// um ChatError lançado pela bridge falha o `instanceof` na rota e degradava para 500.
// Qualquer objeto `{ code, message }` (esta classe, outra cópia dela, ou um erro
// serializado) produz o status correto. Ver statusForError().
//
// Segurança: as respostas NUNCA devolvem a sessão completa — só os campos que o widget
// precisa (code/status/visitorName/realtimeToken). Telefone do visitante e groupJid não
// saem do servidor. Webhook sempre responde 200: um 5xx faz a Evolution reenviar para
// sempre; token errado é ignorado com `{ignored:true}` (registra log, não vaza motivo).

import { ChatError } from "../errors";
import type { ChatBridge } from "../bridge";
import type { ChatLimiter } from "../bridge/types";
import type { ChatConfig } from "../types";

export interface ChatRoutesDeps {
  bridge: ChatBridge;
  /** DI; default: permite tudo (o limite de sessões/IP de domínio vive no ChatBridge). */
  limiter?: ChatLimiter;
  /** DI (LMS: sha256(ip+salt)). Default: `() => null` → limiter nunca é acionado. */
  getIpHash?: (req: Request) => string | null;
  /** Resolvida (await) no início de cada request; o handler faz bridge.setConfig. */
  getConfig: () => Promise<ChatConfig> | ChatConfig;
}

export interface ChatRoutes {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
}

export interface WebhookRouteDeps {
  bridge: ChatBridge;
  getConfig: ChatRoutesDeps["getConfig"];
}

export interface WebhookRoute {
  POST: (req: Request) => Promise<Response>;
}

// Guarda de transporte por IP (a de domínio — 5 sessões/10min — é do ChatBridge).
const POST_LIMIT = 30;
const POST_WINDOW_MS = 60 * 1000;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isFilled(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new ChatError("JSON inválido", "invalid_input");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ChatError("O corpo da requisição deve ser um objeto JSON", "invalid_input");
  }
  return parsed as Record<string, unknown>;
}

// O bridge nomeia o campo na mensagem ("Nome deve ter…", "Telefone inválido"); a rota
// traduz para o nome do campo do corpo (name/phone/message) para o widget destacar.
const FIELD_BY_LABEL: Record<string, string> = { Nome: "name", Mensagem: "message" };

function fieldFromMessage(message: string): string | null {
  if (message.startsWith("Telefone")) return "phone";
  const label = /^(\w+) deve ter\b/.exec(message)?.[1];
  return label === undefined ? null : FIELD_BY_LABEL[label] ?? null;
}

interface StatusForError {
  status: number;
  error: string;
  field?: string;
}

// DUCK-TYPE (ver cabeçalho do arquivo): o `code` é lido por propriedade, nunca por
// `instanceof ChatError` — a classe é duplicada nos bundles do tsup e a comparação de
// identidade falharia entre /bridge e /next. Erro sem `code` reconhecível → 500.
function statusForError(err: unknown): StatusForError {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
  const message =
    typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : "";
  // Objeto duck-typed sem `message` (erro serializado, plain object) ainda responde com o
  // próprio code no corpo — nunca uma string vazia que o widget não conseguiria exibir.
  const text = message !== "" || typeof code !== "string" ? message : code;

  switch (code) {
    case "invalid_input": {
      const field = fieldFromMessage(text);
      return field === null
        ? { status: 422, error: text }
        : { status: 422, error: text, field };
    }
    case "rate_limited":
      return { status: 429, error: text };
    case "session_not_found":
      return { status: 404, error: text };
    case "session_closed":
      return { status: 409, error: text };
    case "group_create_failed":
    case "send_failed":
      return { status: 502, error: text };
    case "disabled":
      return { status: 404, error: "not_found" };
    case "unauthorized":
      return { status: 401, error: text };
    case "store_error":
      return { status: 502, error: text };
    default:
      return { status: 500, error: "erro interno" };
  }
}

function errorResponse(error: unknown): Response {
  const { status, error: message, field } = statusForError(error);
  // 500 só sai do ramo default (nenhum code mapeado responde 500) → é sempre inesperado,
  // e o detalhe fica apenas no log do servidor: o corpo nunca vaza a mensagem original.
  if (status === 500) {
    console.error("[evolution-chat] erro inesperado na rota:", error);
    return json(500, { error: message });
  }
  const body: Record<string, unknown> = { error: message };
  if (field !== undefined) body["field"] = field;
  return json(status, body);
}

export function createChatRoutes(deps: ChatRoutesDeps): ChatRoutes {
  const { bridge } = deps;
  const getIpHash = deps.getIpHash ?? (() => null);

  // GET /api/chat?token=…&after=… — replay de histórico para o widget.
  async function GET(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const token = url.searchParams.get("token");
      if (token === null || token === "") {
        return json(400, { error: "token é obrigatório" });
      }
      bridge.setConfig(await deps.getConfig());
      const after = url.searchParams.get("after");
      const { session, messages } = await bridge.history(token, after);
      if (session === null) return json(404, { error: "session_not_found" });
      return json(200, {
        session: { code: session.code, status: session.status, visitorName: session.visitorName },
        messages,
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  // POST /api/chat — sem token abre chat; com token envia mensagem na sessão.
  async function POST(req: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return errorResponse(error);
    }
    try {
      const cfg = await deps.getConfig();
      bridge.setConfig(cfg);

      const token = asText(body["token"]);
      const ipHash = getIpHash(req);

      if (token === "") {
        // Feature oculta: 404 genérico, nada confirma que o chat existe desligado.
        if (!cfg.enabled) return json(404, { error: "not_found" });
        // Anti-bot silencioso: finge sucesso sem tocar em store/Evolution/limiter.
        if (isFilled(body["honeypot"])) {
          return json(200, { session: { code: "XXXX", status: "closed" }, messages: [] });
        }
      }

      if (deps.limiter !== undefined && ipHash !== null && ipHash !== "") {
        const result = await deps.limiter(ipHash, POST_LIMIT, POST_WINDOW_MS);
        if (!result.success) {
          return json(429, { error: "Muitas requisições. Tente novamente em alguns minutos." });
        }
      }

      if (token !== "") {
        const message = await bridge.sendVisitorMessage(token, asText(body["message"]));
        return json(200, { message });
      }

      const { session, messages } = await bridge.startChat({
        name: asText(body["name"]),
        phone: asText(body["phone"]),
        message: asText(body["message"]),
        contact: typeof body["contact"] === "string" ? body["contact"] : null,
        ipHash,
        userAgent: req.headers.get("user-agent") ?? null,
        honeypot: typeof body["honeypot"] === "string" ? body["honeypot"] : null,
        consent: body["consent"] === true,
      });
      return json(200, {
        session: {
          code: session.code,
          status: session.status,
          realtimeToken: session.realtimeToken,
          visitorName: session.visitorName,
        },
        messages,
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  return { GET, POST };
}

export function createWebhookRoute(deps: WebhookRouteDeps): WebhookRoute {
  const { bridge } = deps;

  // POST /api/chat/webhook — entrada da Evolution. SEMPRE 200 (ver cabeçalho do arquivo).
  async function POST(req: Request): Promise<Response> {
    try {
      const cfg = await deps.getConfig();
      bridge.setConfig(cfg);

      const url = new URL(req.url);
      const token = url.searchParams.get("token") ?? req.headers.get("x-webhook-token") ?? "";
      if (token === "" || token !== cfg.webhookToken) {
        // Log server-side para auditoria; a resposta é neutra e não vaza o motivo.
        console.warn("[evolution-chat] webhook rejeitado: token inválido ou ausente");
        return json(200, { ignored: true });
      }

      let payload: unknown;
      try {
        payload = await req.json();
      } catch {
        console.warn("[evolution-chat] webhook rejeitado: corpo não é JSON válido");
        return json(200, { ignored: true });
      }

      const { handled } = await bridge.handleWebhook(payload);
      return json(200, { handled });
    } catch (error) {
      // getConfig pode falhar (store fora): ainda assim 200, senão a Evolution reenvia.
      console.error("[evolution-chat] webhook falhou (respondendo 200):", error);
      return json(200, { ignored: true });
    }
  }

  return { POST };
}
