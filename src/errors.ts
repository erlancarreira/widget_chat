// src/errors.ts — erro de domínio canônico do SDK.
//
// ChatError carrega um `code` estável para mapear em HTTP nas rotas sem depender
// de instanceof entre bundles (cada entry do tsup inline-iza a classe; usamos
// `.code` para decidir o status). O erro de transporte da Evolution vive em
// src/api/client.ts (EvolutionApiError), junto do cliente que o lança.

export type ChatErrorCode =
  | "invalid_input"
  | "rate_limited"
  | "group_create_failed"
  | "send_failed"
  | "session_not_found"
  | "session_closed"
  | "disabled"
  | "unauthorized"
  | "store_error"
  | "webhook_invalid";

export class ChatError extends Error {
  public readonly code: ChatErrorCode;
  public override readonly cause?: unknown;

  constructor(message: string, code: ChatErrorCode, cause?: unknown) {
    super(message);
    this.name = "ChatError";
    this.code = code;
    this.cause = cause;
  }
}
