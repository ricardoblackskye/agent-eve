import { describe, expect, it } from "vitest";
import { createStateStore } from "../../agent/lib/dark-factory/state-provider";

describe("state-store provider entry point", () => {
  it("provides the fail-closed default without importing the barrel", async () => {
    const store = createStateStore({});

    expect(store.id).toBe("console");
    const result = await store.save("probe", { ready: true });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe("blocked");
  });
});
