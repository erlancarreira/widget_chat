import { describe, expect, it } from "vitest";
import { isValidPhone, normalizePhone, toWhatsappJid } from "../src/api/phone";

describe("normalizePhone", () => {
  it("remove máscara e adiciona DDI 55", () => {
    expect(normalizePhone("(11) 99999-8888")).toBe("5511999998888");
  });
  it("mantém DDI quando já presente", () => {
    expect(normalizePhone("+55 11 99999-8888")).toBe("5511999998888");
  });
  it("suporta DDI estrangeiro explícito", () => {
    expect(normalizePhone("+1 415 555 2671")).toBe("14155552671");
  });
  it("rejeita vazio", () => {
    expect(() => normalizePhone("   ")).toThrow();
  });
});

describe("isValidPhone / toWhatsappJid", () => {
  it("10–15 dígitos ok", () => {
    expect(isValidPhone("5511999998888")).toBe(true);
    expect(isValidPhone("119")).toBe(false);
  });
  it("jid", () => {
    expect(toWhatsappJid("5511999998888")).toBe("5511999998888@s.whatsapp.net");
  });
});
