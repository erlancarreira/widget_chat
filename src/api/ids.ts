// src/api/ids.ts — geração de ids com webcrypto (isomórfico, sem node:crypto).

const SESSION_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sem 0/O/1/I
const SESSION_CODE_LENGTH = 4;
// Rejection sampling: só aceita bytes < 248 (múltiplo de 31 ≤ 256), evitando viés de módulo.
const SESSION_ACCEPT_LIMIT = 256 - (256 % SESSION_ALPHABET.length);

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const TOKEN_BYTES = 24; // 24 bytes → exatamente 32 caracteres base64url, sem padding

function randomChar(alphabet: string, acceptLimit: number): string {
  const buffer = new Uint8Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buffer);
    const byte = buffer[0];
    if (byte !== undefined && byte < acceptLimit) {
      return alphabet.charAt(byte % alphabet.length);
    }
  }
}

export function generateSessionCode(): string {
  return Array.from({ length: SESSION_CODE_LENGTH }, () => randomChar(SESSION_ALPHABET, SESSION_ACCEPT_LIMIT)).join("");
}

export function generateRealtimeToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  let token = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      token += BASE64URL_ALPHABET.charAt((acc >>> bits) & 0x3f);
    }
  }
  return token;
}
