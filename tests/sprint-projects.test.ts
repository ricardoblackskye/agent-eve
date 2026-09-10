import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchSprintBoard } from "../agent/lib/sprint-projects";

const graphqlResponse = {
  data: {
    user: {
      projectV2: {
        title: "Sprint 9",
        items: {
          nodes: [
            {
              content: {
                number: 101,
                title: "Fix login bug",
                createdAt: "2026-09-01T00:00:00Z",
                closedAt: "2026-09-05T00:00:00Z",
              },
              fieldValues: {
                nodes: [{ name: "Done", field: { name: "Status" } }],
              },
            },
            {
              content: {
                number: 102,
                title: "Add CSV export",
                createdAt: "2026-09-02T00:00:00Z",
                closedAt: null,
              },
              fieldValues: {
                nodes: [{ name: "In Progress", field: { name: "Status" } }],
              },
            },
            {
              content: {
                number: 103,
                title: "Sprint report",
                createdAt: "2026-09-03T00:00:00Z",
                closedAt: null,
              },
              fieldValues: {
                nodes: [{ name: "To Do", field: { name: "Status" } }],
              },
            },
          ],
        },
      },
    },
  },
};

describe("fetchSprintBoard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the GraphQL query and normalizes items", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => graphqlResponse,
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
    expect(snapshot.items[0]).toMatchObject({
      number: 101,
      title: "Fix login bug",
      closedAt: "2026-09-05T00:00:00Z",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe("https://api.github.com/graphql");
    const sent = JSON.parse(init.body);
    expect(sent.variables).toEqual({ login: "ricardoblackskye", number: 3 });
    expect(sent.query).toContain("projectV2");
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
