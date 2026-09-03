// src/api/normalize.ts — re-exporta os helpers de telefone de ./phone para
// manter um ponto de import único. O normalizador canônico vive em ./phone.
export { normalizePhone, toWhatsappJid, isValidPhone } from "./phone";
export { phoneToJid } from "./phone";
