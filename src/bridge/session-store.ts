// src/bridge/session-store.ts — re-exporta a porta SessionStore de ./types.
// Mantido como alias fino (a definição canônica vive em bridge/types.ts) para não
// duplicar a interface nem quebrar imports que apontem para este caminho.
export type { SessionStore } from "./types";
