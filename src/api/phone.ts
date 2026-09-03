import { ChatError } from "../errors";

const NON_DIGITS = /\D+/g;

export function normalizePhone(raw: string, defaultDdi = "55"): string {
  const digits = raw.replace(NON_DIGITS, "");
  if (!digits) throw new ChatError("Telefone vazio", "invalid_input");
  // Prefixo "+" explícito (E.164) sinaliza DDI já presente — ex.: "+1 415 555 2671" permanece "14155552671".
  const explicitDdi = raw.includes("+");
  const withDdi = digits.length <= 11 && !explicitDdi && !digits.startsWith(defaultDdi) ? defaultDdi + digits : digits;
  if (withDdi.length < 10 || withDdi.length > 15) {
    throw new ChatError("Telefone inválido", "invalid_input");
  }
  return withDdi;
}
export function isValidPhone(digits: string): boolean {
  return digits.length >= 10 && digits.length <= 15;
}
export function toWhatsappJid(phoneDigits: string): string {
  return `${phoneDigits}@s.whatsapp.net`;
}
