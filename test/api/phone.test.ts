import { describe, it, expect } from "vitest";
import { normalizePhone, toWhatsappJid, isValidPhone } from "../../src/api/phone";

describe("normalizePhone", () => {
  it("adicional DDI 55 a número BR local sem +", () => {
    expect(normalizePhone("(11) 99999-8888")).toBe("5511999998888");
  });

  it("preserva +55 explícito (E.164)", () => {
    expect(normalizePhone("+55 11 99999-8888")).toBe("5511999998888");
  });

  it("mantém número internacional com DDI informado", () => {
    expect(normalizePhone("+1 415 555 2671")).toBe("14155552671");
  });

  it("vazio → lança", () => {
    expect(() => normalizePhone("")).toThrow();
  });

  it("poucos dígitos → lança", () => {
    expect(() => normalizePhone("123")).toThrow();
  });

  it("muitos dígitos (>15) → lança", () => {
    expect(() => normalizePhone("1".repeat(16))).toThrow();
  });

  it("toWhatsappJid anexa sufixo", () => {
    expect(toWhatsappJid("5511999998888")).toBe("5511999998888@s.whatsapp.net");
  });

  it("isValidPhone respeita faixa 10–15", () => {
    expect(isValidPhone("5511999998888")).toBe(true);
    expect(isValidPhone("123")).toBe(false);
  });
});
