# @erlancarreira/evolution-chat

Widget de chat (React) + bridge para a **Evolution API v2** (WhatsApp): o visitante abre uma
conversa no site e o SDK, por padrão, **cria um grupo no WhatsApp** com o visitante e a
plataforma — ou, se `createGroup: false`, manda a mensagem **1:1 direto** para o número da
plataforma. Relaya as mensagens nos dois sentidos e entrega tudo em tempo real no painel, com
**mensagens de sistema** (entrou/saiu do grupo), encerramento automático e **limpeza de grupos
órfãos** (a plataforma sai do grupo quando o visitante sai ou o destino some). Polling de 5 s é
o fallback quando o canal cai. Arquitetura hexagonal: o núcleo (`bridge`) só conhece **portas**
(`SessionStore`, `RealtimeTransport`, `RealtimeHandle`, `ChatLimiter`) — persistência e
transporte são injetados; o adapter oficial usa Supabase, mas qualquer banco serve.

| Subpath | O que entrega |
| --- | --- |
| `./api` | `createEvolutionClient`, parser de webhook, ids, telefone |
| `./bridge` | `ChatBridge`, portas (`SessionStore`, `RealtimeTransport`, …), router |
| `./next` | `createChatRoutes`, `createWebhookRoute` (App Router, sem importar `next`) |
| `./transports/supabase` | `createSupabaseTransport` (server) · `createSupabaseRealtimeHandle` (widget) |
| `./widget` | `<ChatWidget>` React + `injectWidgetStyles` + i18n (pt/en/es) |
| `widget-embed/evolution-chat.iife.js` | `<evolution-chat>` standalone (`<script>`, React embutido) |

## Instalação

```bash
npm install @erlancarreira/evolution-chat          # recomendado: pacote publicado no npm
# alternativas (exigem build local — rode `npm run build` no repo; a saída não é versionada):
npm install github:erlancarreira/evolution-chat    # a partir do repositório
npm install file:../evolution-chat                 # cópia local (cuidado: no Windows vira junction e quebra o build no Vercel)
```

> Passo a passo completo de instalação **+ montagem do painel de administração** em outro
> projeto (Next.js + Supabase), com todas as opções e ações de staff: consulte
> [`skills/configure-evolution-chat.md`](./skills/configure-evolution-chat.md).

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

Sirva `widget-embed/evolution-chat.iife.js` (copie para `public/` ou aponte para o CDN;
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
    leaveOnClose: s?.chatLeaveOnClose ?? true,           // sai do grupo nos fechamentos automáticos (visitante saiu/destino sumiu)
    webhookToken: process.env.CHAT_WEBHOOK_TOKEN!,       // segredo do webhook
    createGroup: s?.chatCreateGroup ?? true,             // true = grupo por visitante; false = conversa 1:1 direta com a plataforma
    groupImage: s?.chatGroupImage ?? "",                 // URL pública da imagem de capa do grupo (vazia = padrão do produto)
  };
}
```

`leaveOnClose`/`closeHours` regem o **fechamento manual** (painel do atendente ou cron): ao
encerrar a sessão (`store.markStatus(id, "closed")`) com `leaveOnClose`, o **hospedeiro** decide
sair do grupo. Já os fechamentos **automáticos** do SDK **não** dependem do host:

- **Visitante sai ou é removido do grupo** (`GROUP_PARTICIPANTS_UPDATE` com `action: leave`/`remove`)
  → a sessão é fechada e a plataforma **sai do grupo** (`client.leaveGroup`) automaticamente.
- **O destino some no envio** (Evolution 404/410 ou "group/left/deleted/blocked" no corpo) →
  `send_target_gone`: sessão fechada com aviso "Conversa encerrada — inicie uma nova" e a
  plataforma sai do grupo.

Fechamentos manuais **não** saem do grupo (o visitante ficaria sozinho). O widget recebe o status
via `{ type: "session", status: "closed" }` que o SDK publica no realtime; sem isso, o status
chega apenas no GET (reabrir o painel ou o polling de fallback).

## Ciclo de vida do grupo, mensagens de sistema e auto-recuperação

- **Modo grupo (padrão) vs 1:1 direto:** `createGroup` controla. No modo grupo, cada visitante
  ativo ganha seu próprio grupo; no modo direto, a mensagem vai para o número da plataforma.
- **Reaproveitamento:** `startChat` reusa a **sessão ativa** do mesmo telefone (um grupo/thread
  por cliente) em vez de abrir grupos novos a cada reabertura.
- **Auto-recuperação de grupo morto:** se a sessão reaproveitada aponta para um grupo que sumiu no
  WhatsApp (visitante apagou/saiu), o envio falha com `target_gone` e o SDK **encerra a sessão
  antiga e cria um grupo novo** para o mesmo visitante — sem grupo zumbi nem histórico travado.
- **Formato novo de participantes (WhatsApp multidevice, Evolution ≥ 2.3):** o webhook pode entregar
  participantes como objetos `{ id: "…@lid", phoneNumber: "…@s.whatsapp.net" }` além de strings.
  O parser normaliza pelo `phoneNumber` (JID real de telefone); com JIDs `@lid` a comparação de
  telefone não é confiável, então **qualquer `leave`/`remove` no grupo encerra a sessão** (fail-safe:
  no pior caso o visitante reabre uma conversa nova — nunca fica sessão zumbi aceitando envios).
- **Validação do número na entrada:** antes de criar o grupo, `startChat` consulta a Evolution
  (`POST /chat/whatsappNumbers/{instance}`, Baileys onWhatsApp). Número que **não existe no
  WhatsApp** → `ChatError("invalid_input")` com mensagem começando em "Telefone" (a rota devolve
  422 com `field: "phone"` e o widget destaca o campo) — sem grupo órfão, sem sessão zumbi.
  Se o checador estiver indisponível (endpoint ausente, erro de rede, shape estranho), o chat
  **segue normalmente** (degradação): a validação nunca é ponto único de falha do atendimento.
- **Falhas transitórias não encerram atendimento:** retransmissão única em falha de rede (conexão
  caiu antes de qualquer resposta) no client; erros 5xx da Evolution marcam a mensagem como `failed`
  mas **não** fecham a sessão — só 404/410 (destino definitivamente inexistente) ou texto de grupo
  morto disparam o encerramento com aviso.
- **Mensagens de sistema:** mudanças de participantes viram `direction: "system"` no chat
  (ex.: "Fulano saiu do grupo"). O schema deve aceitar `direction IN ('visitor','owner','system')`.
- **Webhook:** aponte a Evolution para `/api/chat/webhook?token=<webhookToken>` com os eventos
  `MESSAGES_UPSERT`, `GROUP_PARTICIPANTS_UPDATE` **e** `PRESENCE_UPDATE`. O webhook exige URL pública
  (localhost não recebe da Evolution). O `PRESENCE_UPDATE` alimenta o indicador "digitando…" no widget.

## Indicador de digitação ("3 pontinhos")

O widget mostra os "3 pontinhos" de "digitando…" nos **dois sentidos**, via evento `typing` no canal
em tempo real da sessão (`{ type: "typing", isTyping, from: "owner" | "visitor" }`):

- **WhatsApp → chat (atendente digita):** a Evolution entrega `PRESENCE_UPDATE` no webhook (por isso o
  evento precisa estar subscrito). O SDK resolve a sessão pelo `groupJid` e publica `typing` com
  `from: "owner"` quando quem digita é a **conta da plataforma** (a instância). O widget exibe os
  pontinhos enquanto `isTyping` for `true`; ao enviar a mensagem ou receber `paused`, some.
- **chat → atendente (visitante digita):** o widget POSTa `{ token, isTyping }` em `${endpoint}/typing`
  (ex.: `/api/chat/typing`) sempre que o visitante digita/para de digitar (com *debounce* de 2,5 s). O
  SDK publica `typing` com `from: "visitor"` no mesmo canal, para que uma **interface de atendente** (que
  assine o canal) exiba o indicador.

> **Limitação da presença no WhatsApp:** a Evolution só anuncia a presença da **conta conectada à
> instância**. Como o atendente desta plataforma opera a própria instância, não é possível fazer o
> WhatsApp do atendente "ver" a digitação do visitante (isso exigiria uma conta WhatsApp do visitante,
> que o SDK não controla). Por isso o sentido *chat → WhatsApp* é entregue via o canal em tempo real
> para um painel de atendente; o sentido *WhatsApp → chat* é nativo.

Para expor o sinal "visitante digitando" ao atendente, monte uma rota que chame
`bridge.setVisitorTyping(token, isTyping)` (já incluso no `ChatBridge`) — o `/api/chat/typing` do LMS é
um exemplo.

## Implementando um `SessionStore` próprio

`import type { SessionStore, ChatSession, ChatMessage } from "@erlancarreira/evolution-chat/bridge"`
— é a única superfície de persistência que o bridge usa. Não há cache nem estado em memória.

```ts
export interface SessionStore {
  createSession(input: { code: string; realtimeToken: string; visitorName: string;
    visitorPhone: string; visitorContact?: string | null; groupJid: string | null;
    ipHash?: string | null; userAgent?: string | null }): Promise<ChatSession>;
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
- `countRecentSessionsByIpHash` é a guarda de 5 sessões/IP/10 min. O `ipHash` e o `userAgent`
  da requisição chegam ao adapter via `createSession({ ..., ipHash, userAgent })`, então basta
  persistir as colunas `ip_hash`/`user_agent` da migration para a contagem funcionar contra a
  mesma tabela `chat_sessions` (o adapter Supabase do LMS faz isso). O `limiter` de
  `createChatRoutes` (30 POSTs/min/IP) funciona independente, via a porta `ChatLimiter`.
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

`npm run build` (tsup → `{api,bridge,next,transports/supabase,widget,widget-embed}` na raiz do pacote) ·
`npm test` (vitest, node + jsdom) · `npm run typecheck` · `npm run lint`. Licença: MIT.
