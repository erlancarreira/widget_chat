// src/bridge/index.ts — superfície pública do subpath "@erlancarreira/evolution-chat/bridge".
// Portas (contratos) + ConversationRouter (decisão de roteamento) + ChatBridge (orquestração)
// e a Strategy de formatação. Adapters concretos são exportados pelos seus próprios subpaths
// (./transports/supabase, ./next).

export * from "./types";
export * from "./router";
export * from "./format";
export * from "./bridge";

// Tipos de domínio que aparecem nas assinaturas das portas, reexportados para que o
// consumidor do subpath ./bridge não precise importar do caminho interno src/types.
export type {
  ChatEvent,
  ChatMessage,
  ChatMessageDirection,
  ChatMessageStatus,
  ChatSession,
  ChatSessionStatus,
} from "../types";
