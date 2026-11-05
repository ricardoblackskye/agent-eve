/**
 * #585 T6 (AC1/AC6) - flag parsing and secret refusal.
 *
 * AC1 asks for ONE entry point configured by flags instead of the bootstrap/sandbox-up split.
 * That only holds if the flags are parsed in one place, so this module is the single parser.
 *
 * AC6 asks that no secret ever appears on the command line. A token on argv is visible in the
 * process table to every user on the box and lands in shell history and CI logs. So the parser
 * REFUSES secret flags rather than accepting them: it names the flag, never the value, and
 * points at stdin or a vault handle.
 *
 * Usage errors return exit code 2 and are deliberately outside the ProvisionProblemCode table:
 * a bad flag is caught before provisioning starts, so it cannot be a provisioning failure.
 *
 * These are unit tests over an argument array: no process, no cluster, no network.
 */
import { describe, expect, it } from "vitest";
import {
  parseFlags,
  renderFlagErrors,
  USAGE,
  USAGE_EXIT_CODE,
} from "../../agent/lib/dark-factory/sandbox-flags";

describe("flag parsing (#585 T6 / AC1)", () => {
  it("returns defaults when no flags are given", () => {
    const { flags, errors } = parseFlags([]);
    expect(errors).toEqual([]);
    expect(flags).toEqual({
      check: false,
      help: false,
      version: false,
      forwardPort: undefined,
      cluster: undefined,
      artifactsDir: undefined,
      workspaceDir: undefined,
    });
  });

  it("recognises --check", () => {
    const { flags, errors } = parseFlags(["--check"]);
    expect(errors).toEqual([]);
    expect(flags.check).toBe(true);
  });

  it("recognises --help", () => {
    const { flags } = parseFlags(["--help"]);
    expect(flags.help).toBe(true);
  });

  it("recognises --version", () => {
    const { flags, errors } = parseFlags(["--version"]);
    expect(errors).toEqual([]);
    expect(flags.version).toBe(true);
  });

  it("parses a numeric --forward-port", () => {
    const { flags, errors } = parseFlags(["--forward-port", "19000"]);
    expect(errors).toEqual([]);
    expect(flags.forwardPort).toBe(19000);
  });

  it("rejects a non-numeric --forward-port instead of passing NaN to the core", () => {
    const { errors } = parseFlags(["--forward-port", "eighteen"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("invalid-value");
    expect(renderFlagErrors(errors).join("\n")).toContain("--forward-port");
  });

  it("rejects a --forward-port with no value", () => {
    const { errors } = parseFlags(["--forward-port"]);
    expect(errors[0]?.kind).toBe("missing-value");
  });

  it("parses a local --cluster minikube", () => {
    const { flags, errors } = parseFlags(["--cluster", "minikube"]);
    expect(errors).toEqual([]);
    expect(flags.cluster).toBe("minikube");
  });

  it("parses --kube-context into an object cluster and honours --kubeconfig", () => {
    const { flags, errors } = parseFlags([
      "--kube-context",
      "prod-east",
      "--kubeconfig",
      "C:/kube/config",
    ]);
    expect(errors).toEqual([]);
    expect(flags.cluster).toEqual({ context: "prod-east", kubeconfig: "C:/kube/config" });
  });

  it("parses --artifacts-dir and --workspace-dir", () => {
    const { flags } = parseFlags(["--artifacts-dir", "C:/vendor", "--workspace-dir", "C:/ws"]);
    expect(flags.artifactsDir).toBe("C:/vendor");
    expect(flags.workspaceDir).toBe("C:/ws");
  });

  it("rejects an unknown flag and names it", () => {
    const { errors } = parseFlags(["--nonsense"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("unknown-flag");
    expect(renderFlagErrors(errors).join("\n")).toContain("--nonsense");
  });

  it("collects multiple usage errors in one pass", () => {
    const { errors } = parseFlags(["--nonsense", "--also-nonsense"]);
    expect(errors).toHaveLength(2);
  });
});

describe("secret refusal (#585 T6 / AC6)", () => {
  it("refuses --token <value> and points at stdin or a vault handle", () => {
    const { flags, errors } = parseFlags(["--token", "super-secret-value"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("secret-on-argv");
    const rendered = renderFlagErrors(errors).join("\n");
    expect(rendered).toContain("--token");
    expect(rendered.toLowerCase()).toContain("stdin");
    // AC6: the value must never be echoed, not even in the refusal.
    expect(rendered).not.toContain("super-secret-value");
    // And it must not have been captured into the parsed flags either.
    expect(JSON.stringify(flags)).not.toContain("super-secret-value");
  });

  it("refuses --token=value just as firmly", () => {
    const { errors } = parseFlags(["--token=another-secret"]);
    expect(errors[0]?.kind).toBe("secret-on-argv");
    expect(renderFlagErrors(errors).join("\n")).not.toContain("another-secret");
  });

  it("refuses the other secret-bearing flags", () => {
    for (const flag of ["--password", "--api-key", "--secret"]) {
      const { errors } = parseFlags([flag, "value"]);
      expect(errors[0]?.kind).toBe("secret-on-argv");
      expect(renderFlagErrors(errors).join("\n")).not.toContain("value");
    }
  });
});

describe("documented flags (#585 T6 / AC1)", () => {
  it("documents every accepted flag in the usage text", () => {
    for (const flag of [
      "--check",
      "--help",
      "--version",
      "--forward-port",
      "--cluster",
      "--kube-context",
      "--kubeconfig",
      "--artifacts-dir",
      "--workspace-dir",
    ]) {
      expect(USAGE).toContain(flag);
    }
  });

  it("warns in the usage text that secrets are refused on argv", () => {
    expect(USAGE.toLowerCase()).toContain("stdin");
    expect(USAGE).toContain("--token");
  });

  it("uses exit code 2 for usage errors, outside the provisioning table", () => {
    expect(USAGE_EXIT_CODE).toBe(2);
  });
});
