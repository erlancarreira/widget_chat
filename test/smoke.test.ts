import { describe, it, expect } from "vitest";
import { ChatError } from "../src/errors";

describe("scaffold", () => {
  it("cria ChatError com código", () => {
    const e = new ChatError("boom", "invalid_input");
    expect(e.code).toBe("invalid_input");
    expect(e).toBeInstanceOf(Error);
  });
});
