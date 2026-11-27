import { describe, expect, it } from "vitest";
import {
  buildViewUrl,
  resolveViewBindAddress,
} from "../../agent/lib/dark-factory/sandbox-view";

/**
 * #790 R1 (#791) - the two properties that must hold before any exposure exists.
 *
 * AC3: exposure defaults to localhost. Asserted on the RESOLVED address, not the config string, because the failure
 * this guards is a "localhost" setting that resolves to a wildcard bind. A string assertion would pass while the
 * socket listened on every interface.
 *
 * AC4: no credential value may appear in the URL, output or ledger - and a tokenized URL is forbidden outright. R1
 * secures the view by binding it to loopback, not by putting a secret in a link, so the URL builder must have nowhere
 * to put one. These tests are written before the feature so the leak cannot be introduced while building it.
 */

describe("#790 R1 - AC3: exposure is loopback, asserted on the resolved address", () => {
  it("defaults to loopback when nothing is configured", () => {
    // No configuration at all is the shipping default, so this is the case that actually runs.
    expect(resolveViewBindAddress({})).toBe("127.0.0.1");
  });

  it("resolves an explicit loopback hostname to a loopback address", () => {
    // "localhost" is the string a config is most likely to carry, and it is not itself an address.
    expect(resolveViewBindAddress({ configured: "localhost" })).toBe("127.0.0.1");
  });

  it("accepts IPv6 loopback as loopback", () => {
    expect(resolveViewBindAddress({ configured: "::1" })).toBe("::1");
  });

  it("REFUSES a wildcard bind rather than warning about it", () => {
    // 0.0.0.0 is the exact failure: it looks like a bind-address setting and exposes the workspace to the network.
    // Fail closed - a warning would leave the exposure live.
    expect(() => resolveViewBindAddress({ configured: "0.0.0.0" })).toThrow(/loopback/i);
  });

  it("REFUSES a routable address, and names it in the refusal", () => {
    // A refusal that does not say which address was rejected is one nobody can act on.
    expect(() => resolveViewBindAddress({ configured: "192.168.1.50" })).toThrow(/192\.168\.1\.50/);
  });

  it("CONTROL: a loopback bind is not refused", () => {
    // Guards the guard: if the refusal above were implemented as "always throw", the tests above would pass and the
    // feature would be inert.
    expect(() => resolveViewBindAddress({ configured: "127.0.0.1" })).not.toThrow();
  });
});

describe("#790 R1 - AC4: the URL cannot carry a credential", () => {
  it("builds a URL with no query string and no fragment", () => {
    const url = buildViewUrl({ host: "127.0.0.1", port: 18082 });
    expect(url).toBe("http://127.0.0.1:18082/");
    expect(url).not.toContain("?");
    expect(url).not.toContain("#");
  });

  it("REFUSES to build a URL when handed a credential-looking parameter at all", () => {
    // The forbidden shape is "tokenized URLs", so the builder must not have a parameter that could become one.
    // Passing one is a programming error, not a configuration choice.
    expect(() =>
      buildViewUrl({ host: "127.0.0.1", port: 18082, token: "canary-value" } as never),
    ).toThrow(/token/i);
  });

  it("a canary credential value appears nowhere in the built URL", () => {
    // The canary is deliberately distinctive so a leak is unmistakable rather than arguable.
    const canary = "CANARY-LEAK-DETECTOR-VALUE";
    const url = buildViewUrl({ host: "127.0.0.1", port: 18082 });
    expect(url).not.toContain(canary);
    expect(url).not.toContain("CANARY");
  });

  it("CONTROL: the URL is not empty, so the assertions above cannot pass vacuously", () => {
    // Every negative assertion above would pass on an empty string. This is the assertion that stops that.
    expect(buildViewUrl({ host: "127.0.0.1", port: 18082 }).length).toBeGreaterThan(10);
  });
});
