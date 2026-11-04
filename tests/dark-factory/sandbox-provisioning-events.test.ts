/**
 * #585 T2 (AC3) — the NDJSON event stream.
 *
 * The defect this closes: the GUI (#582) had to screen-scrape prose to know what
 * provisioning was doing. A caller cannot tell "vendor finished" from "deploy finished"
 * when both are one human line. The contract is one JSON object per line on stdout, with
 * a `step` and a `phase`, so the program renders progress and branches without parsing.
 *
 * Two things are pinned here:
 *   1. The emitter writes ONLY valid JSON lines, one per event, and nothing else on stdout.
 *   2. The core actually fires events at each stage boundary — the emitter is useless if
 *      the core never calls it. A fake exec drives the success path; the events are captured
 *      through the injected callback, so this stays a unit test: no cluster, no Docker.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNdjsonEmitter,
  type ProvisionEventInput,
  type ProvisionPhase,
  type ProvisionStep,
} from "../../agent/lib/dark-factory/sandbox-events";
import {
  provisionSandbox,
  type ExecFn,
  type ExecResult,
} from "../../agent/lib/dark-factory/sandbox-provisioning";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const IMAGE_A = "registry.example/opensandbox/execd:release-1.1.1";
const IMAGE_B = "registry.example/opensandbox/egress:release-1.1.1";

/** A workspace with the committed lock and an optionally populated cache. */
function makeArtifacts(options: { tars: number }): string {
  const dir = mkdtempSync(join(tmpdir(), "df-ev-"));
  dirs.push(dir);
  const cache = join(dir, "cache");
  mkdirSync(cache, { recursive: true });
  for (let index = 0; index < options.tars; index += 1) {
    writeFileSync(join(cache, `image-${index}.tar`), "not a real image");
  }
  writeFileSync(
    join(dir, "artifacts.lock.json"),
    JSON.stringify({
      chart: {
        path: "vendor/opensandbox-charts/opensandbox",
        version: "1.2.0",
        source: "https://example.invalid/OpenSandbox",
      },
      crds: { path: "vendor/opensandbox-crds" },
      images: [
        { ref: IMAGE_A, digest: `sha256:${"a".repeat(64)}` },
        { ref: IMAGE_B, digest: `sha256:${"b".repeat(64)}` },
      ],
    }),
  );
  return dir;
}

/** Every process call succeeds; the event sequence is what this test inspects. */
const recorder = (): ExecFn => async () => ({ code: 0, stdout: "", stderr: "" });

const PHASES: ProvisionPhase[] = ["start", "success", "failure", "skip"];
const STEPS: ProvisionStep[] = [
  "check",
  "vendor",
  "cluster",
  "deploy",
  "forward",
  "proof",
  "teardown",
  "done",
];

describe("the NDJSON event emitter (#585 T2)", () => {
  it("writes one valid JSON object per line and nothing else", () => {
    const lines: string[] = [];
    const emit = createNdjsonEmitter({
      write: (line) => lines.push(line),
      now: () => new Date("2026-11-04T14:00:00Z"),
    });

    emit({ step: "vendor", phase: "start", message: "checking artifact cache" });
    emit({ step: "vendor", phase: "success", message: "cache complete" });
    emit({ step: "done", phase: "success", message: "provisioned", exitCode: 0 });

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      // A trailing newline is the NDJSON framing. Without it a consumer reading line-wise
      // blocks on the last event.
      expect(line.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.ts).toBe("2026-11-04T14:00:00.000Z");
      expect(STEPS).toContain(parsed.step as ProvisionStep);
      expect(PHASES).toContain(parsed.phase as ProvisionPhase);
      expect(typeof parsed.message).toBe("string");
    }
    // The terminal event carries the exit code so the GUI can stop on one line.
    expect(JSON.parse(lines[2] as string).exitCode).toBe(0);
  });

  it("keeps prose off stdout: the write channel only ever receives JSON", () => {
    const lines: string[] = [];
    const emit = createNdjsonEmitter({ write: (line) => lines.push(line) });
    emit({ step: "deploy", phase: "start", message: "helm upgrade --install" });
    // If the emitter ever wrote a human sentence here, JSON.parse would throw and the
    // contract ("nothing on stdout that is not JSON") would be broken silently.
    expect(() => JSON.parse(lines[0] as string)).not.toThrow();
    expect(lines[0]).not.toMatch(/^(INFO|ERROR|WARN)/);
  });
});

describe("the provisioning core emits stage events (#585 T2)", () => {
  it("emits events covering vendor, cluster, deploy and proof on a success path", async () => {
    const events: ProvisionEventInput[] = [];
    const artifactsDir = makeArtifacts({ tars: 2 });

    const result = await provisionSandbox({
      artifactsDir,
      workspaceDir: process.cwd(),
      cluster: "minikube",
      forwardPort: 18082,
      exec: recorder(),
      reachSandbox: async () => true,
      runVaultProof: async () => true,
      startForward: async () => async () => {},
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);

    const steps = new Set(events.map((event) => event.step));
    // A caller that only ever hears "done" learns nothing about where time went.
    expect(steps).toContain("vendor");
    expect(steps).toContain("cluster");
    expect(steps).toContain("deploy");
    expect(steps).toContain("proof");

    // Every emitted event is well-formed: a known step and a known phase.
    for (const event of events) {
      expect(STEPS).toContain(event.step);
      expect(PHASES).toContain(event.phase);
      expect(typeof event.message).toBe("string");
      expect(event.message.length).toBeGreaterThan(0);
    }

    // The success path must end on a terminal success, not trail off.
    const last = events.at(-1) as ProvisionEventInput;
    expect(last.step).toBe("done");
    expect(last.phase).toBe("success");
  });

  it("marks the failing stage as a failure phase before returning a refusal", async () => {
    const events: ProvisionEventInput[] = [];
    const artifactsDir = makeArtifacts({ tars: 0 }); // empty cache -> vendor refusal

    const result = await provisionSandbox({
      artifactsDir,
      workspaceDir: process.cwd(),
      cluster: "minikube",
      forwardPort: 18082,
      exec: recorder(),
      reachSandbox: async () => true,
      runVaultProof: async () => true,
      onEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(false);
    const failure = events.find((event) => event.phase === "failure");
    expect(failure).toBeDefined();
    expect(failure?.step).toBe("vendor");
    // The refusal is a terminal event too, carrying the code the CLI maps to an exit code.
    const last = events.at(-1) as ProvisionEventInput;
    expect(last.step).toBe("done");
    expect(last.phase).toBe("failure");
  });

  it("does not require an onEvent callback (existing callers keep working)", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    const result = await provisionSandbox({
      artifactsDir,
      workspaceDir: process.cwd(),
      cluster: "minikube",
      forwardPort: 18082,
      exec: recorder(),
      reachSandbox: async () => true,
      runVaultProof: async () => true,
      startForward: async () => async () => {},
    });
    expect(result.ok).toBe(true);
  });
});
