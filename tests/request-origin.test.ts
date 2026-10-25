import { describe, it, expect } from "vitest";
import { resolveRequestOrigin } from "../app/request-origin";

// #471: a redirect must name the host the CLIENT used. `nextUrl.origin` resolves to the dev server's own
// bind address, so a server bound to 127.0.0.1 answers a request made to 127.0.0.1 with a Location on
// localhost - and the host-only session cookie is dropped on the hop. These cases pin the authority chain
// and the validation that keeps a header from injecting a Location.
describe("resolveRequestOrigin (#471)", () => {
  const nextUrl = { origin: "http://localhost:3000" };

  function headers(values: Record<string, string>): Headers {
    return new Headers(values);
  }

  it("prefers x-forwarded-host and carries x-forwarded-proto", () => {
    expect(
      resolveRequestOrigin({
        headers: headers({
          "x-forwarded-host": "eve.example.com",
          "x-forwarded-proto": "https",
          host: "internal-service:3000",
        }),
        nextUrl,
      }),
    ).toBe("https://eve.example.com");
  });

  it("defaults x-forwarded-proto to https when a proxy omits it", () => {
    expect(
      resolveRequestOrigin({
        headers: headers({ "x-forwarded-host": "eve.example.com" }),
        nextUrl,
      }),
    ).toBe("https://eve.example.com");
  });

  it("uses the client's Host header when no forwarded host exists", () => {
    // The defect this fixes: nextUrl says localhost:3000, but the client asked for 127.0.0.1:3001.
    expect(
      resolveRequestOrigin({
        headers: headers({ host: "127.0.0.1:3001" }),
        nextUrl,
      }),
    ).toBe("http://127.0.0.1:3001");
  });

  it("keeps the port the client used", () => {
    expect(
      resolveRequestOrigin({
        headers: headers({ host: "127.0.0.1:8080" }),
        nextUrl,
      }),
    ).toBe("http://127.0.0.1:8080");
  });

  it("takes the protocol from nextUrl when only Host is present", () => {
    expect(
      resolveRequestOrigin({
        headers: headers({ host: "eve.example.com" }),
        nextUrl: { origin: "https://eve.example.com" },
      }),
    ).toBe("https://eve.example.com");
  });

  it("falls back to nextUrl.origin when no host header is present", () => {
    expect(resolveRequestOrigin({ headers: headers({}), nextUrl })).toBe(
      "http://localhost:3000",
    );
  });

  it("honours a bracketed IPv6 authority", () => {
    expect(
      resolveRequestOrigin({
        headers: headers({ host: "[::1]:3001" }),
        nextUrl,
      }),
    ).toBe("http://[::1]:3001");
  });

  // A header must not be able to inject a Location or a second header. `Headers` already throws on CR/LF,
  // so those two are driven through a stub whose get() hands back the hostile string - that tests this
  // helper's own validator rather than relying on the platform to have refused it first.
  function stubHeaders(values: Record<string, string>) {
    return {
      get: (name: string) => values[name.toLowerCase()] ?? null,
    };
  }

  it.each([
    ["CR", "127.0.0.1:3001\r\nLocation: http://evil.example"],
    ["LF", "127.0.0.1:3001\nLocation: http://evil.example"],
    ["space", "127.0.0.1:3001 http://evil.example"],
    ["at-sign", "evil.example@127.0.0.1:3001"],
    ["path", "127.0.0.1:3001/documentation"],
    ["query", "127.0.0.1:3001?x=1"],
    ["fragment", "127.0.0.1:3001#x"],
    ["backslash", "127.0.0.1:3001\\evil"],
  ])("rejects a Host header containing %s", (_label, hostile) => {
    expect(
      resolveRequestOrigin({
        headers: stubHeaders({ host: hostile }),
        nextUrl,
      }),
    ).toBe("http://localhost:3000");
  });

  it("rejects a hostile x-forwarded-host and falls back to nextUrl", () => {
    expect(
      resolveRequestOrigin({
        headers: stubHeaders({
          "x-forwarded-host": "eve.example.com\r\nLocation: http://evil.example",
          "x-forwarded-proto": "https",
        }),
        nextUrl,
      }),
    ).toBe("http://localhost:3000");
  });

  it("ignores an invalid x-forwarded-proto and uses the Host header", () => {
    // A proxy that sends a nonsense protocol must not become the authority, but the plain Host is still
    // the address the client used, so it is the next-best answer.
    expect(
      resolveRequestOrigin({
        headers: headers({
          "x-forwarded-host": "eve.example.com",
          "x-forwarded-proto": "javascript",
          host: "127.0.0.1:3001",
        }),
        nextUrl,
      }),
    ).toBe("http://127.0.0.1:3001");
  });

  it("takes the first value when x-forwarded-host lists several", () => {
    expect(
      resolveRequestOrigin({
        headers: headers({
          "x-forwarded-host": "eve.example.com, internal-service",
          "x-forwarded-proto": "https",
        }),
        nextUrl,
      }),
    ).toBe("https://eve.example.com");
  });
});
