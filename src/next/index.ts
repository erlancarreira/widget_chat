// src/next/index.ts — superfície pública do subpath "@erlancarreira/evolution-chat/next".
// Factories de rotas (Request/Response puros, compatíveis com o App Router do Next sem
// importar "next"). Tipos auxiliares reexportados para o consumidor não descer a caminhos
// internos (src/types, src/bridge/types).

export * from "./chat-routes";
export type { ChatConfig } from "../types";
export type { ChatLimiter, ChatLimiterResult } from "../bridge/types";
