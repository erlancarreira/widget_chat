---
name: configure-evolution-chat
description: >-
  Instalar o pacote @erlancarreira/evolution-chat (chat de atendimento via WhatsApp /
  Evolution API) em um projeto Next.js + Supabase e montar o painel de administração
  replicando o painel de referência do Aulivra. Inclui as 11 opções de configuração
  (ativar, nome do projeto, número WhatsApp, URL/instância/apiKey da Evolution, mensagem
  de boas-vindas, fechar após X horas, sair do grupo ao fechar, criar grupo por visitante
  vs 1:1 direto, imagem de capa do grupo), as ações de staff (status de conexão, QR de
  pareamento, configurar webhook, envio de teste, desconectar, upload da imagem) e os
  comportamentos (mensagens de sistema, limpeza de grupos órfãos, modo direto 1:1,
  anti-abuso). Use sempre que um projeto precisar adicionar este chat WhatsApp.
---

# Configurar Evolution Chat (`@erlancarreira/evolution-chat`)

Skill para integrar o SDK de chat WhatsApp (baseado em Evolution API v2 / Baileys) em um
projeto **Next.js (App Router) + Supabase**, entregando o mesmo conjunto de opções e
funcionalidades do painel de referência (Aulivra).

## Quando usar
- Um projeto novo ou existente precisa de um widget de atendimento por WhatsApp no site
  público, com grupo por visitante **ou** conversa 1:1 direta.
- O cliente quer um painel de admin para ligar/desligar o chat e configurar a Evolution
  sem mexer em código.

## Pré-requisitos
- Conta Evolution API v2 acessível (URL base + apiKey). A instância pode ser criada pelo
  próprio SDK (`ensureInstance`).
- Projeto Supabase (Postgres + Realtime habilitado).
- Next.js 15/16 App Router, TypeScript.
- O pacote é público no npm: `@erlancarreira/evolution-chat`.

## Passo 1 — Instalar o pacote
Use o gerenciador do projeto (não `file:` — isso quebra o build na Vercel por causa de
junction no Windows; sempre instale do registry):

```bash
npm install @erlancarreira/evolution-chat
# ou: pnpm add @erlancarreira/evolution-chat
```

Subpaths importáveis:
- `@erlancarreira/evolution-chat/api` — `createEvolutionClient`, `normalizePhone`, `EvolutionApiError`
- `@erlancarreira/evolution-chat/bridge` — `ChatBridge`, `ChatError`
- `@erlancarreira/evolution-chat/next` — `createChatRoutes`, `createWebhookRoute`, tipo `ChatConfig`
- `@erlancarreira/evolution-chat/transports/supabase` — `createSupabaseSessionStore`, `createSupabaseTransport`, `createSupabaseRealtimeHandle`
- `@erlancarreira/evolution-chat/widget` — `ChatWidget`

## Passo 2 — Schema do Supabase (migration)
Aplica uma migration idempótica. As tabelas são acessadas **somente via service role** nas
rotas (nunca anon). Realtime é via broadcast (token por sessão), então não depende de RLS.

```sql
-- chat_sessions + chat_messages (SDK evolution-chat)
create table if not exists public.chat_sessions (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  realtime_token  text not null unique,
  visitor_name    text not null,
  visitor_phone   text not null,
  visitor_contact text,
  group_jid       text,
  status          text not null default 'active'
                  check (status in ('active','closed','failed')),
  user_agent      text,
  ip_hash         text,
  created_at      timestamptz not null default timezone('utc', now()),
  updated_at      timestamptz not null default timezone('utc', now()),
  last_message_at timestamptz,
  closed_at       timestamptz,
  close_reason    text
);
create index if not exists idx_chat_sessions_group  on public.chat_sessions(group_jid) where group_jid is not null;
create index if not exists idx_chat_sessions_status on public.chat_sessions(status);

create table if not exists public.chat_messages (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references public.chat_sessions(id) on delete cascade,
  direction     text not null check (direction in ('visitor','owner','system')),
  body          text not null,
  status        text not null default 'sent' check (status in ('pending','sent','failed')),
  wa_message_id text,
  created_at    timestamptz not null default timezone('utc', now())
);
create index if not exists idx_chat_messages_session on public.chat_messages(session_id, created_at);

-- source-of-truth das configurações (key-value). Adapte o nome da tabela ao seu projeto.
create table if not exists public.platform_settings (
  key         text primary key,
  value       text,
  description text,
  updated_at  timestamptz
);

-- Seeds das 11 opções do painel (valores padrão "off"/vazios).
insert into public.platform_settings (key, value, description) values
  ('whatsapp_chat_enabled',        'off', 'Chat WhatsApp no site público (on/off).'),
  ('whatsapp_chat_project_name',   '',    'Nome do projeto usado no assunto do grupo.'),
  ('whatsapp_chat_number',         '',    'Número da plataforma que recebe (E.164, ex: 5511999998888).'),
  ('whatsapp_evolution_url',       '',    'URL base da Evolution API.'),
  ('whatsapp_evolution_instance',  '',    'Nome da instância Baileys na Evolution.'),
  ('whatsapp_evolution_apikey',    '',    'API key da Evolution (SECRETO).'),
  ('whatsapp_chat_welcome',        '',    'Mensagem de boas-vindas do widget.'),
  ('whatsapp_chat_close_hours',    '24',  'Horas de inatividade para encerrar sessão (0 = nunca).'),
  ('whatsapp_chat_leave_on_close', 'off', 'Sair do grupo ao encerrar a sessão (on/off).'),
  ('whatsapp_chat_create_group',   'on',  'Criar grupo por visitante (off = conversa 1:1 direta).'),
  ('whatsapp_chat_group_image',    '',    'URL pública da imagem de capa do grupo.'),
  ('whatsapp_chat_webhook_token',  '',    'Token do webhook da Evolution (SECRETO, gerado pelo painel).')
on conflict (key) do nothing;
```

> O `webhook_token` é gerado automaticamente pelo painel na primeira leitura/gravação, se
> estiver vazio — não precisa criá-lo manualmente.

## Passo 3 — Settings (as 11 opções do painel)
Mapeie cada chave `platform_settings` para o tipo `ChatConfig` (de
`@erlancarreira/evolution-chat/next`). O `getChatConfig()` é resolvido por request e
passado para as rotas via `getConfig`.

```ts
import type { ChatConfig } from "@erlancarreira/evolution-chat/next";

export async function getChatConfig(): Promise<ChatConfig> {
  const s = await getPlatformSettings(); // sua leitura do key-value store
  let webhookToken = (s.whatsapp_chat_webhook_token ?? "").trim();
  if (webhookToken === "") {
    webhookToken = randomBytes(24).toString("base64url"); // gera + persiste se vazio
    await savePlatformSetting("whatsapp_chat_webhook_token", webhookToken);
  }
  return {
    enabled: s.whatsapp_chat_enabled === "on",
    projectName: s.whatsapp_chat_project_name ?? "",
    platformNumber: s.whatsapp_chat_number ?? "",
    evolutionUrl: s.whatsapp_evolution_url ?? "",
    instance: s.whatsapp_evolution_instance ?? "",
    apiKey: s.whatsapp_evolution_apikey ?? "",
    welcome: s.whatsapp_chat_welcome ?? "",
    closeHours: parseCloseHours(s.whatsapp_chat_close_hours), // >=0, senão 0
    leaveOnClose: s.whatsapp_chat_leave_on_close === "on",
    createGroup: s.whatsapp_chat_create_group !== "off",       // on => grupo por visitante
    groupImage: (s.whatsapp_chat_group_image ?? "").trim(),
    webhookToken,
  };
}
```

Regras: `enabled`/`leaveOnClose`/`createGroup` são `"on"|"off"`; `closeHours` é inteiro ≥ 0;
`webhookToken` deve ser estável (gerado uma vez). Nunca exponha `apiKey` ou `webhookToken`
para o cliente/browser.

## Passo 4 — Montar as rotas (API)
Crie dois route handlers no App Router. Eles são `Request → Response` puros.

`app/api/chat/route.ts`:
```ts
import { createChatRoutes } from "@erlancarreira/evolution-chat/next";
import { ChatBridge } from "@erlancarreira/evolution-chat/bridge";
import { createEvolutionClient } from "@erlancarreira/evolution-chat/api";
import {
  createSupabaseSessionStore,
  createSupabaseTransport,
} from "@erlancarreira/evolution-chat/transports/supabase";
import { admin } from "@/lib/supabase/admin"; // SupabaseClient com service role
import { getChatConfig } from "@/lib/chat-config";

const bridge = new ChatBridge({
  client: createEvolutionClient({ baseUrl: "", apiKey: "" }), // credenciais vêm do getConfig
  store: createSupabaseSessionStore(admin),
  transport: createSupabaseTransport(admin),
});

const handlers = createChatRoutes({ bridge, getConfig: getChatConfig });
export const GET = (req: Request) => handlers.GET(req);
export const POST = (req: Request) => handlers.POST(req);
```

`app/api/chat/webhook/route.ts`:
```ts
import { createWebhookRoute } from "@erlancarreira/evolution-chat/next";
// (mesmos imports de bridge/client/store/transport de cima)
const webhook = createWebhookRoute({ bridge, getConfig: getChatConfig });
export const POST = (req: Request) => webhook.POST(req);
```

O webhook **sempre responde 200** (a Evolution reenvia em caso de 5xx); token errado é
ignorado silenciosamente.

## Passo 5 — Widget no site público
```tsx
import { ChatWidget } from "@erlancarreira/evolution-chat/widget";
import { createSupabaseRealtimeHandle } from "@erlancarreira/evolution-chat/transports/supabase";

const realtime = createSupabaseRealtimeHandle(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export function SiteChat() {
  return (
    <ChatWidget
      endpoint="/api/chat"
      locale="pt"
      projectName="Meu Projeto"
      realtime={realtime}
    />
  );
}
```
O CSS é auto-injetado no mount. Para servir via `<link>`, importe
`@erlancarreira/evolution-chat/widget/styles.css`.

## Passo 6 — Painel de admin (opções + ações de staff)
Replique o `ChatSettingsCard` com:

**Opções persistidas (toggle/input/switch):**
1. `whatsapp_chat_enabled` — Ativar chat no site (Switch)
2. `whatsapp_chat_project_name` — Nome do projeto (assunto do grupo)
3. `whatsapp_chat_number` — Número WhatsApp (E.164)
4. `whatsapp_evolution_url` — URL da Evolution API
5. `whatsapp_evolution_instance` — Instância
6. `whatsapp_evolution_apikey` — API key (input type=password)
7. `whatsapp_chat_welcome` — Mensagem de boas-vindas (textarea)
8. `whatsapp_chat_close_hours` — Fechar após N horas (input numérico; 0 = nunca)
9. `whatsapp_chat_leave_on_close` — Sair do grupo ao fechar (Switch)
10. `whatsapp_chat_create_group` — Criar grupo por visitante (Switch; **off** = 1:1 direto)
11. `whatsapp_chat_group_image` — Imagem de capa do grupo (upload p/ bucket público)

**Ações de staff** (todas atrás de auth `platform_admin`):
- `getChatConnectionStatus` → `client.getConnectionState(instance)` ("open"|"connecting"|"close")
- `getChatConnectQR` → `client.ensureInstance(instance)` + `client.connectQR(instance)` (QR base64 + pairing code)
- `setupChatWebhook` → `client.ensureInstance(instance)` + `client.setWebhook(instance, url, EVENTS)` onde
  `url = `${baseUrl}/api/chat/webhook?token=${token}`` e
  `EVENTS = ["MESSAGES_UPSERT", "GROUP_PARTICIPANTS_UPDATE"]`
- `sendChatTestMessage(number)` → `normalizePhone(number)` + `client.sendText(instance, jid, "🧪 Teste...")`
- `disconnectChat` → `client.logout(instance)`
- `uploadChatGroupImage(formData)` → upload p/ bucket público (ex.: `chat-assets`, 5 MB, `public:true`) e retorna URL

Nunca retorne `apiKey`/`webhookToken` ao cliente; só a URL pública do webhook (que contém o
token de callback) é segura de expor ao admin.

## Passo 7 — Webhook na Evolution
Aponte a instância para `https://<seu-dominio>/api/chat/webhook?token=<webhookToken>` com os
eventos `MESSAGES_UPSERT` e `GROUP_PARTICIPANTS_UPDATE`. **Precisa de URL pública** — em
localhost a Evolution não consegue chamar de volta (use Vercel/túnel para testar).

## Funcionalidades entregues (grátis com o SDK)
- **Grupo por visitante** (padrão) ou **conversa 1:1 direta** (`createGroup: false`).
- **Mensagens de sistema** no chat (entrou/saiu/removido) — `direction: "system"`.
- **Limpeza de grupos órfãos**: ao sair/ser removido (`visitor_left`) ou quando o destino
  some no envio (`send_target_gone`), a sessão é fechada e a empresa sai do grupo
  (`leaveGroup`). Fechamento normal por atendente **não** sai do grupo.
- **Reaproveitamento de grupo**: `startChat` reusa a sessão ativa do telefone (evita group
  sprawl ao reabrir o chat).
- **Anti-abuso**: honeypot silencioso, limite de sessões por IP (5/10min) e por request.
- **Realtime** via Supabase broadcast `chat:<realtimeToken>` (token = única credencial).

## Armadilhas (gotchas)
- **Não use `file:../evolution-chat`** como dependência — funciona localmente no Windows via
  junction, mas o Vercel não acha o caminho e o build quebra. Sempre `^0.1.1` do npm.
- O `ChatError` é duplicado em cada bundle do tsup: jamais compare com `instanceof` entre
  subpaths; as rotas mapeiam status por `code` (duck-typing).
- Supabase Realtime deve estar habilitado no projeto.
- O webhook exige URL pública; não teste a detecção de saída em localhost.

## Verificação
1. `npm run build` do projeto passa (SDK resolvido do registry).
2. Painel: salvar config e clicar em "Configurar webhook" retorna a URL com token.
3. "Conectar (QR)" mostra QR/pairing; status fica "open" após escanear.
4. Site público: abrir widget, enviar mensagem → chega no WhatsApp da empresa (grupo ou 1:1).
5. Responder no WhatsApp → aparece no widget via realtime.
6. Sair do grupo no WhatsApp → mensagem de sistema "saiu" + sessão fechada + empresa sai.
