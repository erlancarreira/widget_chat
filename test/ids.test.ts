import { describe, expect, it } from "vitest";
import { generateRealtimeToken, generateSessionCode } from "../src/api/ids";

const CODE_REGEX = /^[A-HJ-KM-NP-Z2-9]{4}$/;
const SESSION_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sem 0/O/1/I
const TOKEN_REGEX = /^[A-Za-z0-9_-]{32}$/;

describe("generateSessionCode", () => {
  it("gera 4 caracteres do alfabeto (sem 0/O/1/I) em 200 gerações", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateSessionCode();
      expect(code).toMatch(CODE_REGEX);
      for (const char of code) {
        expect(SESSION_ALPHABET).toContain(char);
      }
    }
  });

  it("200 gerações sem repetição sequencial e com unicidade sane", () => {
    const codes = Array.from({ length: 200 }, () => generateSessionCode());
    for (let i = 1; i < codes.length; i++) {
      expect(codes[i]).not.toBe(codes[i - 1]);
    }
    // 31^4 ≈ 923k combinações → colisões em 200 sorteios devem ser raríssimas.
    expect(new Set(codes).size).toBeGreaterThan(190);
  });
});

describe("generateRealtimeToken", () => {
  it("gera 32 caracteres base64url", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateRealtimeToken()).toMatch(TOKEN_REGEX);
    }
  });

  it("gera tokens distintos entre execuções", () => {
    const tokens = Array.from({ length: 50 }, () => generateRealtimeToken());
    expect(new Set(tokens).size).toBe(50);
  });
});
