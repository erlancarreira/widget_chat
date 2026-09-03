# @erlancarreira/evolution-chat

Widget de chat (React) + bridge para a **Evolution API v2** (WhatsApp): o visitante abre uma
conversa no site, o SDK cria um grupo no WhatsApp com o número da plataforma, relaya as
mensagens nos dois sentidos e entrega tudo em tempo real no painel — com polling de 5 s como
fallback quando o canal cai. Arquitetura hexagonal: o núcleo (`bridge`) só conhece **portas**
(`SessionStore`, `RealtimeTransport`, `RealtimeHandle`, `ChatLimiter`) — persistência e
transporte são injetados; o adapter oficial usa Supabase, mas qualquer banco serve.

| Subpath | O que entrega |
| --- | --- |
| `./api` | `createEvolutionClient`, parser de webhook, ids, telefone |
| `./bridge` | `ChatBridge`, portas (`SessionStore`, `RealtimeTransport`, …), router |
| `./next` | `createChatRoutes`, `createWebhookRoute` (App Router, sem importar `next`) |
| `./transports/supabase` | `createSupabaseTransport` (server) · `createSupabaseRealtimeHandle` (widget) |
| `./widget` | `<ChatWidget>` React + `injectWidgetStyles` + i18n (pt/en/es) |
| `dist/widget-embed/evolution-chat.iife.js` | `<evolution-chat>` standalone (`<script>`, React embutido) |

## Instalação

```bash
npm install @erlancarreira/evolution-chat   # npm (react + react-dom são peers)
npm install github:erlan/evolution-chat     # do repositório — rode `npm run build` (dist/ não é versionado)
npm install file:../evolution-chat          # cópia local em desenvolvimento (idem)
```

`@supabase/supabase-js` é peer **opcional** (só para os adapters de realtime). No `<script>`
nada disso se aplica: React, react-dom e supabase-js vão embutidos.

## Quickstart — Next.js (App Router)

**1. Monte o bridge uma vez (server-only).** `getConfig` é resolvido a cada request, então a
config pode viver numa tabela de settings do tenant.

```ts
// lib/chat/server.ts
import { createClient } from "@supabase/supabase-js";
import { createEvolutionClient } from "@erlancarreira/evolution-chat/api";
import { ChatBridge } from "@erlancarreira/evolution-chat/bridge";
import { createSupabaseTransport } from "@erlancarreira/evolution-chat/transports/supabase";
import { createChatRoutes, createWebhookRoute } from "@erlancarreira/evolution-chat/next";
import { createSessionStore } from "./session-store";   // seu adapter (ver seção)
import { getChatConfig } from "./settings";              // () => Promise<ChatConfig>

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const bridge = new ChatBridge({
  client: createEvolutionClient({ baseUrl: process.env.EVOLUTION_URL!, apiKey: process.env.EVOLUTION_API_KEY! }),
  store: createSessionStore(admin),
  transport: createSupabaseTransport(admin),
});

export const chat = createChatRoutes({ bridge, getConfig: getChatConfig, getIpHash: hashIp });
// hashIp: (req) => sha256(ip + salt) — sem isto o limite de sessões por IP não roda
export const webhook = createWebhookRoute({ bridge, getConfig: getChatConfig });
```

**2. Encaminhe as rotas.**

```ts
// app/api/chat/route.ts
export const GET = (req: Request) => chat.GET(req);
export const POST = (req: Request) => chat.POST(req);

// app/api/chat/webhook/route.ts  →  Evolution aponta para /api/chat/webhook?token=<webhookToken>
export const POST = (req: Request) => webhook.POST(req);
```

**3. Renderize o widget** (client component). O CSS é auto-injetado no mount (prefere `<link>`?
importe `@erlancarreira/evolution-chat/widget/styles.css`); `realtime` é a porta que assina o canal da sessão.

```tsx
"use client";
import { ChatWidget } from "@erlancarreira/evolution-chat/widget";
import { createSupabaseRealtimeHandle } from "@erlancarreira/evolution-chat/transports/supabase";

const realtime = createSupabaseRealtimeHandle(process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

export function SupportChat() {
  return <ChatWidget endpoint="/api/chat" locale="pt" projectName="Aulivra"
    welcome="Fale com a gente no WhatsApp" accentColor="#25D366" realtime={realtime} />;
}
```

## Quickstart — `<script>` (sem bundler)

Sirva `dist/widget-embed/evolution-chat.iife.js` (copie para `public/` ou aponte para o CDN;
≈1 MB não minificado, ~207 kB gzip) e use a tag: atributos viram props, e
`data-supabase-url`/`data-supabase-key` ligam o realtime — sem eles o widget cai no polling de
5 s em vez de quebrar.

```html
<script src="/evolution-chat.iife.js"></script>
<evolution-chat
  endpoint="/api/chat"
  locale="pt"
  welcome="Precisa de ajuda?"
  project="Aulivra"
  accent="#25D366"
  data-supabase-url="https://xyz.supabase.co"
  data-supabase-key="chave-anon-publica"
></evolution-chat>
```

O widget monta dentro de um **shadow root** (o CSS `.ecw-*` é injetado lá dentro, isolando os dois
lados). A global do bundle é `EvolutionChatEmbed`; incluir o script duas vezes não lança.

## `ChatConfig`

É o objeto que `getConfig` devolve, a cada request. O padrão é ler de settings do tenant, com os segredos vindos de env:

```ts
import type { ChatConfig } from "@erlancarreira/evolution-chat/next";

export async function getChatConfig(): Promise<ChatConfig> {
  const s = await db.settings.findFirst();
  return {
    enabled: s?.chatEnabled ?? false,                    // false → POST /api/chat devolve 404
    projectName: s?.chatProjectName ?? "Aulivra",        // assunto do grupo: "<projectName> — <nome> (#CODE)"
    platformNumber: s?.chatPlatformNumber ?? "5511999998888", // número da plataforma (só dígitos, com DDI)
    evolutionUrl: process.env.EVOLUTION_URL!,            // ex.: https://evolution.exemplo.com.br
    instance: process.env.EVOLUTION_INSTANCE!,           // instância conectada a esse número
    apiKey: process.env.EVOLUTION_API_KEY!,              // apikey da instância (NUNCA vai ao cliente)
    welcome: s?.chatWelcome ?? "Como podemos ajudar?",
    closeHours: s?.chatCloseHours ?? 24,                 // inatividade p/ fechar (0 = nunca)
    leaveOnClose: s?.chatLeaveOnClose ?? true,           // sai do grupo ao encerrar
    webhookToken: process.env.CHAT_WEBHOOK_TOKEN!,       // segredo do webhook
  };
}
```

`closeHours`/`leaveOnClose` são consumidos pelo **hospedeiro**: quem fecha (cron, painel do
atendente) chama `store.markStatus(id, "closed")` e, se `leaveOnClose`,
`client.leaveGroup(instance, groupJid)`. Para avisar o visitante na hora, publique
`{ type: "session", status: "closed" }` via `transport.publish` — hoje o SDK publica só
`{ type: "message" }`; sem esse publish o status chega ao widget apenas no GET (reabrir o
painel, ou o polling quando o canal cai).

## Implementando um `SessionStore` próprio

`import type { SessionStore, ChatSession, ChatMessage } from "@erlancarreira/evolution-chat/bridge"`
— é a única superfície de persistência que o bridge usa. Não há cache nem estado em memória.

```ts
export interface SessionStore {
  createSession(input: { code: string; realtimeToken: string; visitorName: string;
    visitorPhone: string; visitorContact?: string | null; groupJid: string | null }): Promise<ChatSession>;
  getSessionByToken(token: string): Promise<ChatSession | null>;         // token = realtimeToken
  getSessionByGroupJid(jid: string): Promise<ChatSession | null>;        // roteia o webhook pelo grupo
  appendMessage(input: { sessionId: string; direction: ChatMessageDirection; body: string;
    waMessageId?: string | null; status?: ChatMessageStatus }): Promise<ChatMessage>;
  updateMessageStatus(id: string, status: ChatMessageStatus): Promise<void>;
  listMessages(sessionId: string, afterIso?: string | null): Promise<ChatMessage[]>;
  findMessageByWaId(sessionId: string, waMessageId: string): Promise<ChatMessage | null>;
  registerSentMessageId(sessionId: string, waMessageId: string): Promise<void>;
  isEcho(sessionId: string, waMessageId: string): Promise<boolean>;
  touchSession(sessionId: string, atIso: string): Promise<void>;
  setGroupJid(sessionId: string, groupJid: string): Promise<void>;
  markStatus(sessionId: string, status: ChatSessionStatus, reason?: string): Promise<void>;
  countRecentSessionsByIpHash(ipHash: string, windowMs: number): Promise<number>;
}
```

O que o bridge **espera** do seu adapter:

- `appendMessage` devolve a mensagem com `id` e `createdAt` (ISO) preenchidos — `createdAt` é o
  cursor do polling/replay.
- `findMessageByWaId` + `registerSentMessageId`/`isEcho` sustentam a idempotência: a Evolution
  reenvia enquanto não devolvemos `handled: true`, e o eco das mensagens que **nós** enviamos
  precisa ser reconhecido (tabela própria de ids, não uma coluna em `messages`).
- `getSessionByGroupJid` é 1 grupo ↔ 1 sessão; o router **não** filtra por status, então
  devolva `null` em `closed`/`failed` para não anexar mensagens a conversa encerrada.
  `touchSession` atualiza `lastMessageAt` (o que alimenta um job de `closeHours`).
- `countRecentSessionsByIpHash` é a guarda de 5 sessões/IP/10 min — mas a porta não transporta
  `ipHash` até `createSession`, então o adapter precisa de fonte própria para esse par (tabela
  lateral escrita no request, ou contador Redis com TTL). O `limiter` de `createChatRoutes`
  funciona sem nenhuma tabela.
- Falha de infraestrutura: `throw` — as rotas mapeiam para 500/502 (nunca 422).

## Segurança

- **Webhook sempre responde 200.** Um 5xx faz a Evolution reentregar para sempre; token
  inválido, corpo não-JSON e erro interno devolvem `{ ignored: true }` com log server-side, sem
  vazar o motivo. O `webhookToken` (URL `?token=…` ou header `x-webhook-token`) é a única
  credencial do endpoint: valor longo e aleatório, trocado se vazar.
- **Não logue segredos.** `apiKey` e `webhookToken` ficam no servidor (`getConfig`); as rotas
  nunca devolvem a sessão completa — só `code`/`status`/`visitorName` (mais o `realtimeToken` no
  POST que abre a conversa). Telefone do visitante e `groupJid` não saem do servidor.
- **Rate limit em duas camadas:** 5 sessões/IP/10 min no bridge e 30 POSTs/min/IP no `limiter`
  das rotas. O honeypot `website` faz o bot receber sucesso falso, sem tocar em banco nem
  Evolution.
- **RLS no Supabase:** as tabelas ficam só para a service role (adapter server-side); habilite
  RLS sem policies para `anon`. O canal de realtime é **broadcast** (não passa por RLS) — por
  isso a credencial de escuta é o `realtimeToken` de 192 bits gerado por sessão. No `<script>`,
  `data-supabase-key` é a chave **anon/public** — nunca a service role.

## Desenvolvimento

`npm run build` (tsup → `dist/{api,bridge,next,transports/supabase,widget,widget-embed}`) ·
`npm test` (vitest, node + jsdom) · `npm run typecheck` · `npm run lint`. Licença: MIT.
