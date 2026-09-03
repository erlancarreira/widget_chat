// src/errors.ts
export class ChatError extends Error {
  constructor(message: string, readonly code: ChatErrorCode, readonly cause?: unknown) { super(message); }
}
export type ChatErrorCode =
  | "invalid_input" | "rate_limited" | "group_create_failed"
  | "send_failed" | "session_not_found" | "session_closed"
  | "disabled" | "unauthorized" | "store_error";
