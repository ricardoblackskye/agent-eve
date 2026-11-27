/**
 * #790 R1 (#791) - exposing a local sandbox for observation, read-only.
 *
 * Two properties are decided here rather than at the call site, because both are the kind that get lost when they are
 * left to whoever wires the feature up:
 *
 *   1. The view binds to loopback, and the decision is made on the RESOLVED address. A "localhost" setting that
 *      resolves to a wildcard bind would pass any check made against the configured string while the socket listened on
 *      every interface. A non-loopback bind is refused, not warned about: a warning leaves the exposure live.
 *
 *   2. The view URL cannot carry a credential. R1 secures the view by binding it to loopback rather than by putting a
 *      secret in a link, so the builder has no parameter that could become a token, and refuses at runtime if a caller
 *      passes one anyway.
 *
 * Both fail closed. Scope is R1's: local sandboxes only, no ingress, no tunnel, no new provider.
 */

/** The port the local sandbox control plane is forwarded to, and the endpoint's documented default. */
export const DEFAULT_VIEW_PORT = 18082;

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "localhost"]);

export interface ViewBindOptions {
  /** A configured bind host. Absent means the default, which is loopback. */
  configured?: string;
}

/**
 * Resolve the address the view may bind to.
 *
 * Returns the resolved loopback address, and throws when the request would expose the workspace beyond this machine.
 * The thrown message names the offending address, because a refusal nobody can act on is a refusal that gets worked
 * around - and the workaround would be to widen the bind.
 */
export function resolveViewBindAddress(options: ViewBindOptions = {}): string {
  const configured = (options.configured ?? "").trim();

  // No configuration is the shipping default. It must be loopback, and it must be loopback without anyone deciding.
  if (configured === "") return "127.0.0.1";

  if (!LOOPBACK_ADDRESSES.has(configured.toLowerCase())) {
    throw new Error(
      `Refusing to bind the sandbox view to "${configured}": R1 exposes a local sandbox read-only and must bind to ` +
        `loopback (127.0.0.1 or ::1). Binding to a wildcard or routable address would expose the workspace to the ` +
        `network, which is R4's problem to solve properly - with ingress or a tunnel - not this one to solve by widening.`,
    );
  }

  // "localhost" is a name, not an address, so it is resolved here rather than passed through: a caller that receives
  // it back cannot tell whether it resolved to loopback.
  return configured.toLowerCase() === "localhost" ? "127.0.0.1" : configured;
}

export interface ViewUrlOptions {
  host: string;
  port: number;
}

/**
 * Build the URL an operator follows to watch the sandbox.
 *
 * Deliberately shaped so a credential cannot be added: the options carry a host and a port, and any attempt to pass a
 * token fails loudly rather than being ignored. An ignored parameter would be worse than a refused one, because the
 * caller would believe the view was secured.
 */
export function buildViewUrl(options: ViewUrlOptions): string {
  const unexpected = Object.keys(options as unknown as Record<string, unknown>).filter(
    (key) => key !== "host" && key !== "port",
  );
  const credentialLike = unexpected.find((key) => /token|secret|credential|auth|key|pass/i.test(key));
  if (credentialLike) {
    throw new Error(
      `Refusing to build a view URL with a "${credentialLike}" parameter: R1 secures the view by binding it to loopback, ` +
        `never by putting a credential in a link. A tokenized URL would leak into logs, history and the ledger the ` +
        `moment anyone copied it.`,
    );
  }
  if (unexpected.length > 0) {
    throw new Error(`Unexpected view URL option(s): ${unexpected.join(", ")}`);
  }

  const host = options.host;
  const port = options.port;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Refusing to build a view URL with an invalid port: ${port}`);
  }

  // No query string, no fragment, nothing appended. The trailing slash is the bare root of the served workspace.
  return `http://${host}:${port}/`;
}
