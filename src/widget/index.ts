// src/widget/index.ts — superfície pública do subpath "@erlancarreira/evolution-chat/widget".
//
// O consumidor (LMS) faz:
//   import { ChatWidget } from "@erlancarreira/evolution-chat/widget";
//   import type { ChatWidgetProps } from "@erlancarreira/evolution-chat/widget";
//   <ChatWidget endpoint="/api/chat" locale="pt" welcome="Oi!" projectName="Aulivra" realtime={supabaseRealtime} />
//
// O CSS é auto-injetado (`injectWidgetStyles` roda no mount do ChatWidget); quem quiser
// servir por `<link>` importa o subpath "./widget/styles.css".

export { ChatWidget } from "./chat-widget";
export type { ChatWidgetProps, WidgetLocale } from "./chat-widget";

export { injectWidgetStyles, WIDGET_CSS } from "./styles";

export {
  WIDGET_KEYS,
  dictionaries,
  en,
  es,
  pt,
  t,
} from "./i18n";
export type { WidgetDictionary, WidgetKey } from "./i18n";

export {
  isValidPhone,
  maskPhone,
  normalizePhone,
  useChat,
  SESSION_STORAGE_KEY,
  POLL_INTERVAL_MS,
  MIN_PHONE_DIGITS,
} from "./use-chat";
export type { ChatPhase, ChatState, SessionInfo, UseChatOptions, UseChatResult } from "./use-chat";

// Porta injetada — reexportada para o consumidor não descer ao subpath ./bridge.
export type { RealtimeHandle } from "../bridge/types";
