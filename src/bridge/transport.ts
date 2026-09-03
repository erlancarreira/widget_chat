// src/bridge/transport.ts — re-exporta a porta RealtimeTransport de ./types.
// Mantido como alias fino para não duplicar a definição canônica (e evitar que um
// import antigo quebre). A fonte da verdade é bridge/types.ts.
export type { RealtimeTransport, RealtimeHandle } from "./types";
