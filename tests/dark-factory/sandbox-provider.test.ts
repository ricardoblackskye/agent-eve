import { describe, expect, it } from "vitest";
import {
  createSandboxProvider,
  SUPPORTED_SANDBOX_DRIVERS,
} from "../../agent/lib/dark-factory/sandbox-provider";

/**
 * #280 T2 — the toggle is OFF by default and fail-closed.
 *
 * There is deliberately no boolean "enable" flag: a boolean can default open, while a driver NAME
 * cannot. Absence means today's behaviour.
 */
describe("#280 createSandboxProvider", () => {
  it("defaults to local when DF_SANDBOX_DRIVER is unset", () => {
    expect(createSandboxProvider({}).driver).toBe("local");
  });

  it("treats an empty or whitespace value as unset", () => {
    expect(createSandboxProvider({ DF_SANDBOX_DRIVER: "" }).driver).toBe("local");
    expect(createSandboxProvider({ DF_SANDBOX_DRIVER: "   " }).driver).toBe("local");
  });

  it("selects local explicitly", () => {
    expect(createSandboxProvider({ DF_SANDBOX_DRIVER: "local" }).driver).toBe("local");
  });

  it("selects dry-run, which reports it is NOT isolated", () => {
    const provider = createSandboxProvider({ DF_SANDBOX_DRIVER: "dry-run" });
    expect(provider.driver).toBe("dry-run");
    expect(provider.isolated).toBe(false);
  });

  it("resolves the live sandbox arm without creating anything (creation is lazy)", () => {
    const provider = createSandboxProvider({ DF_SANDBOX_DRIVER: "opensandbox" });
    expect(provider.driver).toBe("opensandbox");
    expect(provider.isolated).toBe(true);
  });

  it("throws on an unknown driver, naming the supported values", () => {
    expect(() => createSandboxProvider({ DF_SANDBOX_DRIVER: "remote-sandbox" })).toThrow(
      /Supported values: local, dry-run/,
    );
  });

  it("offers only the documented drivers (no boolean that could default open)", () => {
    // #281 T4 adds the live sandbox arm; this assertion is the guard on the SET.
    expect([...SUPPORTED_SANDBOX_DRIVERS]).toEqual(["local", "dry-run", "opensandbox"]);
  });
});
