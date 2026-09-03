// src/bridge/index.ts — superfície pública do subpath "@erlancarreira/evolution-chat/bridge".
// Portas (contratos) + ConversationRouter (decisão de roteamento) + ChatBridge (orquestração)
// e a Strategy de formatação. Adapters concretos são exportados pelos seus próprios subpaths
// (./transports/supabase, ./next).

export * from "./types";
export * from "./router";
export * from "./format";
export * from "./bridge";

// Erros de domínio compartilhados: o consumidor externo (ex.: stores do LMS) precisa
// importar ChatError/ChatErrorCode daqui para que `instanceof ChatError` funcione —
// cópias locais do tipo nunca casam com os erros lançados pelas rotas do SDK.
export * from "../errors";

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
