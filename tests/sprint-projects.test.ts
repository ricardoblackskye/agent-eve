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

function pageBody(
  title: string,
  items: unknown[],
  hasNextPage: boolean,
  endCursor: string | null,
): unknown {
  return {
    data: {
      user: {
        projectV2: {
          title,
          items: {
            pageInfo: { hasNextPage, endCursor },
            nodes: items,
          },
        },
      },
    },
  };
}

describe("fetchSprintBoard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the GraphQL query and normalizes items", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () =>
        pageBody(
          "Sprint 9",
          [
            makeItem(101, "Done"),
            makeItem(102, "In Progress"),
            makeItem(103, "To Do"),
          ],
          false,
          null,
        ),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchSprintBoard("tok", "ricardoblackskye", 3);

    expect(snapshot.projectTitle).toBe("Sprint 9");
    expect(snapshot.items).toHaveLength(3);
    expect(snapshot.items.map((i) => i.status)).toEqual([
      "Done",
      "In Progress",
      "To Do",
    ]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe("https://api.github.com/graphql");
    const sent = JSON.parse(init.body);
    expect(sent.variables).toEqual({
      login: "ricardoblackskye",
      number: 3,
      cursor: null,
    });
    expect(sent.query).toContain("projectV2");
    expect(sent.query).toContain("organization(login");
  });

  it("paginates through all items across multiple pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      makeItem(i + 1, "Done"),
    );
    const page2 = Array.from({ length: 50 }, (_, i) =>
      makeItem(100 + i + 1, "In Progress"),
    );

    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      const vars = JSON.parse(init?.body ?? "{}").variables;
      const cursor = vars?.cursor;
      if (!cursor) {
        return {
          ok: true,
          status: 200,
          json: async () => pageBody("Sprint 9", page1, true, "abc123"),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => pageBody("Sprint 9", page2, false, null),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchSprintBoard("tok", "ricardoblackskye", 3);

    expect(snapshot.items).toHaveLength(150);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns empty status when the item has no Status field (no wrong-column fallback)", async () => {
    const itemWithPriorityOnly = {
      content: {
        number: 1,
        title: "x",
        createdAt: "2026-09-01T00:00:00Z",
        closedAt: null,
      },
      fieldValues: {
        nodes: [{ name: "High", field: { name: "Priority" } }],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          pageBody("Sprint 9", [itemWithPriorityOnly], false, null),
      })),
    );

    const snapshot = await fetchSprintBoard("tok", "ricardoblackskye", 3);
    expect(snapshot.items[0].status).toBe("");
  });

  it("resolves organization-owned projects via the organization root field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            user: null,
            organization: {
              projectV2: {
                title: "Org Sprint",
                items: {
                  nodes: [makeItem(7, "Done")],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      })),
    );

    const snapshot = await fetchSprintBoard("tok", "my-org", 3);
    expect(snapshot.projectTitle).toBe("Org Sprint");
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].number).toBe(7);
  });

  it("surfaces a clear 403 for a missing read:project scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })),
    );
    await expect(
      fetchSprintBoard("tok", "ricardoblackskye", 3),
    ).rejects.toThrow(/read:project|403/i);
  });

  it("surfaces a clear read:project error when GraphQL returns FORBIDDEN", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
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
      })),
    );
    await expect(
      fetchSprintBoard("tok", "ricardoblackskye", 3),
    ).rejects.toThrow(/read:project/i);
  });
});
