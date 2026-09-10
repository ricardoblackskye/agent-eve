export interface SprintBoardItem {
  number: number;
  title: string;
  /** Kanban column (single-select "Status" option), e.g. "To Do" / "In Progress" / "Done". */
  status: string;
  createdAt: string;
  closedAt?: string | null;
}

export interface SprintBoardSnapshot {
  projectTitle: string;
  items: SprintBoardItem[];
}

const GRAPHQL_URL = "https://api.github.com/graphql";

const QUERY = `
  query SprintBoard($login: String!, $number: Int!) {
    user(login: $login) {
      projectV2(number: $number) {
        title
        items(first: 100) {
          nodes {
            content {
              ... on Issue {
                number
                title
                createdAt
                closedAt
              }
            }
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field {
                    ... on ProjectV2SingleSelectField {
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

type FieldValueNode = { name?: string; field?: { name?: string } };

function findStatus(nodes: unknown[]): string {
  const singleSelects = (nodes as FieldValueNode[]).filter(
    (n) => n && typeof n.name === "string",
  );
  const status = singleSelects.find(
    (n) => (n.field?.name ?? "").toLowerCase() === "status",
  );
  return (status ?? singleSelects[0])?.name ?? "";
}

function normalize(body: unknown): SprintBoardSnapshot {
  const project = (
    body as {
      data?: { user?: { projectV2?: ProjectV2Raw } };
    }
  )?.data?.user?.projectV2;
  if (!project) {
    throw new Error("Projects board not found (check login + project number)");
  }
  const items = (project.items?.nodes ?? []).map((node) => {
    const content = (node.content ?? {}) as {
      number?: number;
      title?: string;
      createdAt?: string;
      closedAt?: string | null;
    };
    return {
      number: content.number ?? 0,
      title: content.title ?? "",
      status: findStatus(node.fieldValues?.nodes ?? []),
      createdAt: content.createdAt ?? "",
      closedAt: content.closedAt ?? null,
    };
  });
  return { projectTitle: project.title ?? "", items };
}

type ProjectV2Raw = {
  title?: string;
  items?: {
    nodes?: Array<{
      content?: unknown;
      fieldValues?: { nodes?: unknown[] };
    }>;
  };
};

/**
 * Fetch a GitHub Projects (V2) Kanban board snapshot and normalize it into a
 * flat item list with each item's current status column. Requires a token with
 * `read:project` scope; a 403 surfaces an explicit scope message.
 */
export async function fetchSprintBoard(
  token: string,
  login: string,
  projectNumber: number,
): Promise<SprintBoardSnapshot> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { login, number: projectNumber },
    }),
  });
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error(
        "Projects API 403: token lacks 'read:project' scope (required to read this board).",
      );
    }
    throw new Error(`Projects API error ${res.status}`);
  }
  return normalize(await res.json());
}
