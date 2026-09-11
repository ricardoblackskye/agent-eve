export interface SprintBoardItem {
  number: number;
  title: string;
  /** Kanban column (single-select "Status" option), e.g. "To Do" / "In Progress" / "Done". Empty string when no Status field. */
  status: string;
  createdAt: string;
  closedAt?: string | null;
}

export interface SprintBoardSnapshot {
  projectTitle: string;
  items: SprintBoardItem[];
}

const GRAPHQL_URL = "https://api.github.com/graphql";
const PAGE_SIZE = 100;

// The board may belong to a user OR an organization. We query both root fields
// in one request (GitHub guarantees a login is unique across users + orgs, so
// exactly one resolves) and pick the non-null one. This avoids a REST
// round-trip or an owner-type config flag.
const QUERY = `
  query SprintBoard($login: String!, $number: Int!, $cursor: String) {
    user(login: $login) {
      projectV2(number: $number) { ...BoardFields }
    }
    organization(login: $login) {
      projectV2(number: $number) { ...BoardFields }
    }
  }
  fragment BoardFields on ProjectV2 {
    title
    items(first: ${PAGE_SIZE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        content {
          ... on Issue { number title createdAt closedAt }
        }
        fieldValues(first: 20) {
          nodes {
            ... on ProjectV2ItemFieldSingleSelectValue {
              name
              field { ... on ProjectV2SingleSelectField { name } }
            }
          }
        }
      }
    }
  }
`;

type FieldValueNode = { name?: string; field?: { name?: string } };
type ItemNode = {
  content?: {
    number?: number;
    title?: string;
    createdAt?: string;
    closedAt?: string | null;
  };
  fieldValues?: { nodes?: unknown[] };
};
type ProjectV2Data = {
  title?: string;
  items?: {
    nodes?: ItemNode[];
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  };
};

/**
 * Resolve an item's status column. Only the field literally named "Status" is
 * accepted — never fall back to the first single-select (which might be
 * "Priority" or "Effort" and would corrupt the metrics). Returns "" when no
 * Status field is present.
 */
function findStatus(nodes: unknown[]): string {
  const singleSelects = (nodes as FieldValueNode[]).filter(
    (n) => n && typeof n.name === "string",
  );
  const status = singleSelects.find(
    (n) => (n.field?.name ?? "").toLowerCase() === "status",
  );
  return status?.name ?? "";
}

function normalizeItem(node: ItemNode): SprintBoardItem {
  const content = node.content ?? {};
  return {
    number: content.number ?? 0,
    title: content.title ?? "",
    status: findStatus(node.fieldValues?.nodes ?? []),
    createdAt: content.createdAt ?? "",
    closedAt: content.closedAt ?? null,
  };
}

type BoardBody = {
  errors?: Array<{ type?: string; message?: string }>;
  data?: {
    user?: { projectV2?: ProjectV2Data | null } | null;
    organization?: { projectV2?: ProjectV2Data | null } | null;
  };
};

/**
 * Fetch a GitHub Projects (V2) Kanban board snapshot, paginating through ALL
 * items (cursor-based) so boards larger than one page are not silently
 * truncated. Supports user-owned and organization-owned projects. Requires a
 * token with `read:project` scope; a 403/`FORBIDDEN` surfaces an explicit
 * scope message.
 */
export async function fetchSprintBoard(
  token: string,
  login: string,
  projectNumber: number,
): Promise<SprintBoardSnapshot> {
  const items: SprintBoardItem[] = [];
  let projectTitle = "";
  let cursor: string | null = null;

  for (;;) {
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: QUERY,
        variables: { login, number: projectNumber, cursor },
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

    const body = (await res.json()) as BoardBody;
    if (body.errors?.length) {
      const first = body.errors[0];
      const msg = first.message ?? "unknown error";
      if (
        first.type === "FORBIDDEN" ||
        msg.toLowerCase().includes("not accessible")
      ) {
        throw new Error(
          "Projects API: token lacks 'read:project' scope (Resource not accessible by personal access token).",
        );
      }
      throw new Error(`Projects API error: ${msg}`);
    }

    const project =
      body.data?.user?.projectV2 ?? body.data?.organization?.projectV2;
    if (!project) {
      throw new Error(
        "Projects board not found (check login + project number)",
      );
    }
    if (!projectTitle) projectTitle = project.title ?? "";

    const nodes = project.items?.nodes ?? [];
    items.push(...nodes.map(normalizeItem));

    const pageInfo = project.items?.pageInfo;
    if (pageInfo?.hasNextPage && pageInfo?.endCursor) {
      cursor = pageInfo.endCursor;
    } else {
      break;
    }
  }

  return { projectTitle, items };
}
