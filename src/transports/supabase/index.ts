// src/transports/supabase/index.ts — adapter Supabase Realtime (broadcast) para as portas
// RealtimeTransport (server publica) e RealtimeHandle (widget assina).
//
// Canal por sessão: `chat:<realtimeToken>`, evento broadcast `chat`, payload = ChatEvent.
// O token aleatório de 24 bytes (192 bits, src/api/ids.ts) gerado na criação da sessão é a
// única credencial do canal (broadcast não passa por RLS), então quem não tem o token não escuta.
//
// Server (createSupabaseTransport): recebe um SupabaseClient já construído pelo hospedeiro
// (tipicamente com a service key). Não assinamos o canal: no supabase-js v2, `send()` num
// canal não-joined cai no endpoint REST de broadcast (POST /realtime/v1/api/broadcast), que
// é exatamente o caminho recomendado para publicar sem manter um WebSocket aberto. Basta
// aguardar o `send()` — ele resolve com 'ok' | 'timed out' | 'error' | …
//
// Widget (createSupabaseRealtimeHandle): constrói seu próprio client com a anon key e
// assina o canal; `subscribe` devolve o `unsubscribe` (deixa o canal) e reporta a conexão
// via onStatus ("open" em SUBSCRIBED, "closed" em CHANNEL_ERROR/TIMED_OUT/CLOSED).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ChatEvent, RealtimeHandle, RealtimeTransport } from "../../bridge";

/** Prefixo do canal por sessão: `chat:<realtimeToken>`. */
const CHANNEL_PREFIX = "chat:";
/** Nome do evento broadcast (o único usado pelo SDK). */
const BROADCAST_EVENT = "chat";

const channelName = (realtimeToken: string): string => `${CHANNEL_PREFIX}${realtimeToken}`;

// Um único client por (url) por página. Reconstruir o client a cada render (StrictMode,
// HMR, múltiplos mounts do widget) cria várias instâncias de GoTrueClient competindo pela
// MESMA chave de localStorage do client de autenticação do app → dispara o aviso
// "Multiple GoTrueClient instances detected". Cacheamos e isolamos o auth do realtime.
const clientCache = new Map<string, SupabaseClient>();

function getRealtimeClient(url: string, anonKey: string): SupabaseClient {
  const cached = clientCache.get(url);
  if (cached) return cached;

  const client = createClient(url, anonKey, {
    auth: {
      // O widget só assina um canal broadcast público: não precisa de sessão persistida,
      // nem de refresh de token, nem de ler a URL. Desligar o persist + usar storageKey
      // próprio garante que este client NÃO concorra com o auth do app pela mesma chave.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: "evolution-chat-realtime",
    },
  });

  clientCache.set(url, client);
  return client;
}

/** Test-only: esvazia o cache de clientes entre testes. */
export function __resetRealtimeClientCache(): void {
  clientCache.clear();
}

/**
 * Estados de assinatura do Realtime → "open"/"closed" da porta.
 * Comparar via lookup (e não `status === "SUBSCRIBED"`) porque REALTIME_SUBSCRIBE_STATES é
 * um enum string não reexportado por @supabase/supabase-js; o valor em runtime é a string.
 * Desconhecidos caem em "closed" (conservador: o widget mostra "reconectando").
 */
const STATUS_BY_REALTIME_STATE: Record<string, "open" | "closed"> = {
  SUBSCRIBED: "open",
  CHANNEL_ERROR: "closed",
  TIMED_OUT: "closed",
  CLOSED: "closed",
};

/** Publica `event` no canal broadcast da sessão. Rejeita se o broadcast não for aceito. */
export function createSupabaseTransport(admin: SupabaseClient): RealtimeTransport {
  return {
    async publish(realtimeToken: string, event: ChatEvent): Promise<void> {
      const channel = channelName(realtimeToken);
      const response = await admin.channel(channel).send({
        type: "broadcast",
        event: BROADCAST_EVENT,
        payload: event,
      });
      // 'ok' | 'timed out' | 'error' | 'rate limited' | 'channel error' | …
      // Rejeitar em não-'ok' é intencional: o bridge (Task 6) captura e devolve
      // handled:false, acionando a reentrega idempotente do webhook.
      if (response !== "ok") {
        throw new Error(`Supabase broadcast "${channel}" não entregue: ${response}`);
      }
    },
  };
}

/**
 * Handle client-side (widget): `subscribe(token, onEvent, onStatus?)` assina
 * `chat:<token>` e devolve o unsubscribe. O client é criado uma única vez na fábrica.
 */
export function createSupabaseRealtimeHandle(url: string, anonKey: string): RealtimeHandle {
  const client = getRealtimeClient(url, anonKey);

  return {
    subscribe(realtimeToken, onEvent, onStatus) {
      const channel = client.channel(channelName(realtimeToken));

      channel.on("broadcast", { event: BROADCAST_EVENT }, (message: { payload: unknown }) => {
        onEvent(message.payload as ChatEvent);
      });

      channel.subscribe((status: string) => {
        onStatus?.(STATUS_BY_REALTIME_STATE[status] ?? "closed");
      });

      return () => {
        void channel.unsubscribe();
      };
    },
  };
}
