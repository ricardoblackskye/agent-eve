import { describe, expect, it, vi } from "vitest";
import {
  createOpenSandboxProvider,
  type SandboxCreateSpec,
} from "../../agent/lib/dark-factory/opensandbox-driver";
import { createSandboxProvider } from "../../agent/lib/dark-factory/sandbox-provider";

describe("sandbox metadata threading (T5b/B4)", () => {
  it("createOpenSandboxProvider passes metadata into the create spec", async () => {
    let captured: SandboxCreateSpec | undefined;
    const provider = createOpenSandboxProvider(
      { DF_SANDBOX_EGRESS_ALLOW: "gw.example" },
      {
        createSandbox: async (spec) => {
          captured = spec;
          return {
            id: "sb-1",
            commands: {
              run: async () => ({
                exitCode: 0,
                logs: { stdout: [], stderr: [] },
              }),
            },
            files: {
              readFile: async () => "",
              writeFiles: async () => {},
              listDirectory: async () => [],
            },
            kill: async () => {},
            close: async () => {},
          };
        },
        metadata: { run: "run-3" },
      },
    );
    // Force lazy creation by touching the sandbox.
    await provider.create("/workspace").readFile("a.ts");
    expect(captured?.metadata).toEqual({ run: "run-3" });
  });

  it("createSandboxProvider threads runId into the opensandbox arm as metadata.run", async () => {
    const spy = vi.fn();
    // Replace the live creator with one that records the metadata, via the factory's deps override.
    const provider = createSandboxProvider(
      { DF_SANDBOX_DRIVER: "opensandbox" },
      {
        createSandbox: async (spec) => {
          spy(spec.metadata);
          return {
            id: "sb-1",
            commands: {
              run: async () => ({
                exitCode: 0,
                logs: { stdout: [], stderr: [] },
              }),
            },
            files: {
              readFile: async () => "",
              writeFiles: async () => {},
              listDirectory: async () => [],
            },
            kill: async () => {},
            close: async () => {},
          };
        },
      },
      "run-9",
    );
    await provider.create("/workspace").readFile("a.ts");
    expect(spy).toHaveBeenCalledWith({ run: "run-9" });
  });
});
