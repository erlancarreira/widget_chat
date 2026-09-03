// src/api/index.ts — superfície pública do subpacote `evolution-chat/api`.
//
// Cliente HTTP tipado e framework-agnóstico da Evolution API v2. Auth por header
// `apikey`. Sem dependências pesadas (fetch global). O erro de transporte
// (EvolutionApiError) é exportado daqui para o painel distinguir evolution_error
// de config_error.

export * from "./phone";
export * from "./ids";
export * from "./client";
export * from "./webhook-parser";

// Tipos canônicos compartilhados (re-export para conveniência).
export type { InboundMessage } from "../types";
