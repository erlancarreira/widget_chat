// src/widget/i18n.ts — dicionários do widget (pt/en/es) + helper `t`.
//
// Contrato (Task 9): as 15 chaves abaixo são OBRIGATÓRIAS em todos os idiomas — o tipo
// `WidgetDictionary = Record<WidgetKey, string>` torna a paridade verificável pelo
// compilador, e o teste em test/widget/widget.test.tsx a pinar em runtime.
//
// `t(locale, key, overrides?)` resolve na ordem: override do consumidor → dicionário do
// locale → pt (fallback seguro) → própria chave (nunca devolve undefined).

export type WidgetLocale = "pt" | "en" | "es";

export const WIDGET_KEYS = [
  "openChat",
  "close",
  "name",
  "phone",
  "message",
  "send",
  "sending",
  "welcomeNotice",
  "privacyNote",
  "invalidPhone",
  "sendError",
  "retry",
  "sessionClosed",
  "newConversation",
  "poweredBy",
  "typing",
  "loading",
] as const;

export type WidgetKey = (typeof WIDGET_KEYS)[number];

/** Dicionário completo: `Record<WidgetKey, string>` força todas as chaves no compilador. */
export type WidgetDictionary = Record<WidgetKey, string>;

export const pt: WidgetDictionary = {
  openChat: "Abrir chat",
  close: "Fechar",
  name: "Nome",
  phone: "WhatsApp",
  message: "Mensagem",
  send: "Enviar",
  sending: "Enviando…",
  welcomeNotice: "Ao continuar, você entra no grupo de WhatsApp do site com o nosso time.",
  privacyNote: "Seus dados são usados apenas para o atendimento.",
  invalidPhone: "Informe um número válido com DDD (mínimo 10 dígitos).",
  sendError: "Não foi possível enviar. Tente novamente.",
  retry: "Tentar novamente",
  sessionClosed: "Esta conversa foi encerrada. Abra uma nova para continuar.",
  newConversation: "Iniciar nova conversa",
  poweredBy: "Powered by",
  typing: "digitando…",
  loading: "Carregando conversa…",
};

export const en: WidgetDictionary = {
  openChat: "Open chat",
  close: "Close",
  name: "Name",
  phone: "WhatsApp",
  message: "Message",
  send: "Send",
  sending: "Sending…",
  welcomeNotice: "When you continue, you join the site's WhatsApp group with our team.",
  privacyNote: "Your data is used only for support.",
  invalidPhone: "Enter a valid number with area code (at least 10 digits).",
  sendError: "Couldn't send. Please try again.",
  retry: "Try again",
  sessionClosed: "This conversation was closed. Start a new one to continue.",
  newConversation: "Start a new conversation",
  poweredBy: "Powered by",
  typing: "typing…",
  loading: "Loading conversation…",
};

export const es: WidgetDictionary = {
  openChat: "Abrir chat",
  close: "Cerrar",
  name: "Nombre",
  phone: "WhatsApp",
  message: "Mensaje",
  send: "Enviar",
  sending: "Enviando…",
  welcomeNotice: "Al continuar, entras en el grupo de WhatsApp del sitio con nuestro equipo.",
  privacyNote: "Tus datos se usan solo para la atención.",
  invalidPhone: "Introduce un número válido con área (mínimo 10 dígitos).",
  sendError: "No se pudo enviar. Inténtalo de nuevo.",
  retry: "Reintentar",
  sessionClosed: "Esta conversación fue cerrada. Abre una nueva para continuar.",
  newConversation: "Iniciar nueva conversación",
  poweredBy: "Powered by",
  typing: "escribiendo…",
  loading: "Cargando conversación…",
};

export const dictionaries: Record<WidgetLocale, WidgetDictionary> = { pt, en, es };

/**
 * Traduz `key` para `locale`, permitindo override pontual de copy (`labels` do widget).
 * Nunca lança: chave desconhecida devolve o texto de pt e, na ausência, a própria chave.
 */
export function t(
  locale: WidgetLocale,
  key: WidgetKey,
  overrides?: Partial<Record<string, string>>,
): string {
  const override = overrides?.[key];
  if (override !== undefined) return override;
  const dict: Partial<WidgetDictionary> = dictionaries[locale];
  return dict[key] ?? dictionaries.pt[key] ?? key;
}
