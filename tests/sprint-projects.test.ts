import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchSprintBoard } from "../agent/lib/sprint-projects";

function makeItem(number: number, status: string): unknown {
  return {
    content: {
      number,
      title: `Item ${number}`,
      createdAt: "2026-09-01T00:00:00Z",
      closedAt: status === "Done" ? "2026-09-05T00:00:00Z" : null,
    },
    fieldValues: { nodes: [{ name: status, field: { name: "Status" } }] },
  };
}

// mock the REST /users/{login} owner-type probe to return "User"
function mockUserOwnerType(): unknown {
  return { type: "User" };
}

// mock the REST /users/{login} owner-type probe to return "Organization"
function mockOrgOwnerType(): unknown {
  return { type: "Organization" };
}

// Build a mocked fetch that first answers the REST owner-type probe, then the
// GraphQL board query (user or org variant) for as many pages as supplied.
function mockFetcher({
  ownerType = "User",
  pages,
}: {
  ownerType?: "User" | "Organization";
  pages: Array<{
    title: string;
    items: unknown[];
    hasNextPage: boolean;
    endCursor: string | null;
  }>;
}): ReturnType<typeof vi.fn> {
  let pageIdx = 0;
  return vi.fn(async (u: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const uClean = String(u).split("?")[0];
    // REST owner-type probe (first call only)
    if (uClean === "https://api.github.com/users/ricardoblackskye") {
      return {
        ok: true,
        status: 200,
        json: async () =>
          ownerType === "Organization"
            ? mockOrgOwnerType()
            : mockUserOwnerType(),
      };
    }
    if (uClean === "https://api.github.com/users/my-org") {
      return {
        ok: true,
        status: 200,
        json: async () =>
          ownerType === "Organization"
            ? mockOrgOwnerType()
            : mockUserOwnerType(),
      };
    }
    // GraphQL board query
    if (uClean === "https://api.github.com/graphql") {
      const vars = JSON.parse(init?.body ?? "{}").variables;
      const page = pages[Math.min(pageIdx++, pages.length - 1)];
      const isOrg = ownerType === "Organization";
      const root = isOrg ? "organization" : "user";
      const body: unknown = {
        data: {
          [root]: {
            projectV2: {
              title: page.title,
              items: {
                pageInfo: {
                  hasNextPage: page.hasNextPage,
                  endCursor: page.endCursor,
                },
                nodes: page.items,
              },
            },
          },
          // the other root is null-ish so the probe's choice prevails
          ...(isOrg ? { user: null } : { organization: null }),
        },
      };
      void vars; // cursor handled by page sequencing above
      return {
        ok: true,
        status: 200,
        json: async () => body,
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

describe("fetchSprintBoard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("probes owner type via REST, then POSTs the user GraphQL query for a user-owned board", async () => {
    const fetchMock = mockFetcher({
      ownerType: "User",
      pages: [
        {
          title: "Sprint 9",
          items: [
            makeItem(101, "Done"),
            makeItem(102, "In Progress"),
            makeItem(103, "To Do"),
          ],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchSprintBoard("tok", "ricardoblackskye", 3);

    expect(snapshot.projectTitle).toBe("Sprint 9");
    expect(snapshot.items).toHaveLength(3);
    expect(snapshot.items.map((i) => i.status)).toEqual([
      "Done",
      "In Progress",
      "To Do",
    ]);
    // two calls: REST probe then GraphQL
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const restCall = fetchMock.mock.calls[0] as unknown as [string, unknown];
    expect(restCall[0]).toBe("https://api.github.com/users/ricardoblackskye");
    const gqlCall = fetchMock.mock.calls[1] as unknown as [
      string,
      { body: string },
    ];
    const sent = JSON.parse(gqlCall[1].body);
    expect(sent.variables).toEqual({
      login: "ricardoblackskye",
      number: 3,
      cursor: null,
    });
    // the query must use the user root, NOT organization
    expect(sent.query).toContain("user(login");
    expect(sent.query).not.toContain("organization(login");
  });

  it("probes owner type then uses organization root for an org-owned board", async () => {
    const fetchMock = mockFetcher({
      ownerType: "Organization",
      pages: [
        {
          title: "Org Sprint",
          items: [makeItem(7, "Done")],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchSprintBoard("tok", "my-org", 3);
    expect(snapshot.projectTitle).toBe("Org Sprint");
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].number).toBe(7);

    const gqlCall = fetchMock.mock.calls[1] as unknown as [
      string,
      { body: string },
    ];
    expect(JSON.parse(gqlCall[1].body).query).toContain("organization(login");
  });

  it("paginates through all items across multiple pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      makeItem(i + 1, "Done"),
    );
    const page2 = Array.from({ length: 50 }, (_, i) =>
      makeItem(100 + i + 1, "In Progress"),
    );
    const fetchMock = mockFetcher({
      ownerType: "User",
      pages: [
        {
          title: "Sprint 9",
          items: page1,
          hasNextPage: true,
          endCursor: "abc123",
        },
        {
          title: "Sprint 9",
          items: page2,
          hasNextPage: false,
          endCursor: null,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchSprintBoard("tok", "ricardoblackskye", 3);
    expect(snapshot.items).toHaveLength(150);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 REST + 2 GraphQL pages
  });

  it("returns empty status when the item has no Status field (no wrong-column fallback)", async () => {
    const itemWithPriorityOnly = {
      content: {
        number: 1,
        title: "x",
        createdAt: "2026-09-01T00:00:00Z",
        closedAt: null,
      },
      fieldValues: { nodes: [{ name: "High", field: { name: "Priority" } }] },
    };
    vi.stubGlobal(
      "fetch",
      mockFetcher({
        ownerType: "User",
        pages: [
          {
            title: "Sprint 9",
            items: [itemWithPriorityOnly],
            hasNextPage: false,
            endCursor: null,
          },
        ],
      }),
    );

    const snapshot = await fetchSprintBoard("tok", "ricardoblackskye", 3);
    expect(snapshot.items[0].status).toBe("");
  });

  it("surfaces a clear 403 for a missing read:project scope", async () => {
    vi.stubGlobal("fetch", mockFetcher({ ownerType: "User", pages: [] }));
    // override to fail the GraphQL call specifically
    const failing = vi.fn(async (u: string, init?: { method?: string }) => {
      const uClean = String(u).split("?")[0];
      if (uClean === "https://api.github.com/users/ricardoblackskye") {
        return { ok: true, status: 200, json: async () => ({ type: "User" }) };
      }
      return { ok: false, status: 403, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", failing);
    await expect(
      fetchSprintBoard("tok", "ricardoblackskye", 3),
    ).rejects.toThrow(/read:project|403/i);
  });

  it("surfaces a clear read:project error when GraphQL returns FORBIDDEN", async () => {
    vi.stubGlobal("fetch", mockFetcher({ ownerType: "User", pages: [] }));
    const failing = vi.fn(async (u: string, init?: { method?: string }) => {
      const uClean = String(u).split("?")[0];
      if (uClean === "https://api.github.com/users/ricardoblackskye") {
        return { ok: true, status: 200, json: async () => ({ type: "User" }) };
      }
      if (uClean === "https://api.github.com/graphql") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            errors: [
              {
                type: "FORBIDDEN",
                message: "Resource not accessible by personal access token",
              },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", failing);
    await expect(
      fetchSprintBoard("tok", "ricardoblackskye", 3),
    ).rejects.toThrow(/read:project/i);
  });

  it("fails fast when the owner login does not exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        // /users/{login} and /orgs/{login} both 404 for a nonexistent login.
        if (
          u.includes("/users/ghost-login-xyz") ||
          u.includes("/orgs/ghost-login-xyz")
        ) {
          return {
            ok: false,
            status: 404,
            json: async () => ({ message: "Not Found" }),
            text: async () => "Not Found",
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );
    await expect(fetchSprintBoard("tok", "ghost-login-xyz", 3)).rejects.toThrow(
      /Could not resolve owner|404/i,
    );
  });

  // --- LIVE smoke test (requires GITHUB_SPRINT_TOKEN env) ---
  // Verifies the real ricardoblackskye #3 board parses. Skipped in pure unit
  // runs unless GH_SPRINT_TOKEN is present.
  const liveToken = process.env.GH_SPRINT_TOKEN;
  (liveToken ? it : it.skip)(
    "LIVE: fetches the real ricardoblackskye project #3 board",
    async () => {
      const snapshot = await fetchSprintBoard(
        liveToken!,
        "ricardoblackskye",
        3,
      );
      expect(snapshot.projectTitle).toBe("Agent Eve");
      expect(snapshot.items.length).toBeGreaterThan(0);
      // every item has a status (strict match picked the Status column)
      expect(snapshot.items.every((i) => typeof i.status === "string")).toBe(
        true,
      );
    },
    20000,
  );
});
