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
const REST_URL = "https://api.github.com";
const PAGE_SIZE = 100;

// The board may belong to a user OR an organization. We probe the owner type
// via the REST API and then issue a user-rooted or org-rooted GraphQL query.
// (Querying both roots in one request is unsafe: organization(login: <user-
// account>) returns a hard NOT_FOUND error that shadows the valid user result.))
//
// NB: the selection is INLINED (no fragment spread) — GitHub's schema rejects
// variables referenced inside a fragment ("variableNotUsed" /
// "cannotSpreadFragment"). The field list is duplicated across USER_QUERY and
// ORG_QUERY to stay on the correct root.
const USER_QUERY = `
  query SprintBoard($login: String!, $number: Int!, $cursor: String) {
    user(login: $login) {
      projectV2(number: $number) {
        title
        items(first: ${PAGE_SIZE}, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            content { ... on Issue { number title createdAt closedAt } }
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
    }
  }
`;

const ORG_QUERY = `
  query SprintBoard($login: String!, $number: Int!, $cursor: String) {
    organization(login: $login) {
      projectV2(number: $number) {
        title
        items(first: ${PAGE_SIZE}, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            content { ... on Issue { number title createdAt closedAt } }
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

/** Auth header value built with string concatenation so the literal token
 * is never interpolated into a template literal (avoids accidental secret
 * capture in logs/transcripts). GitHub accepts "Bearer <token>". */
function authHeader(token: string): string {
  return "Bearer " + token;
}

const GITHUB_HEADERS = (token: string) => ({
  authorization: authHeader(token),
  accept: "application/vnd.github+json",
  "content-type": "application/json",
});

/**
 * Cheaply determine whether `login` is a user account or an organization via
 * the REST API, then issue the matching GraphQL root query.
 *
 * We do NOT query both GraphQL roots in one request: organization(login:<user-
 * account>) returns a hard NOT_FOUND error that shadows the valid user() result,
 * and vice-versa for user-owned boards queried via organization().
 *
 * REST probe (both endpoints are 404 for unknown accounts):
 *   GET /users/{login}  -> 200 "User"|"Organization"|...  OR  404 (it's an org)
 *   GET /orgs/{login}   -> 200 "Organization"  OR  404 (it's a user)
 * /users first covers the common case; the /orgs fallback fixes the regression
 * where organization-owned boards 404'd from /users and were misclassified as
 * "user" (causing user(login:...) to return null for the org's board).
 */
async function resolveOwnerType(
  token: string,
  login: string,
): Promise<"user" | "org"> {
  // GET /users/{login} returns type "User", "Organization", "Bot", etc.
  // For an org login it returns 404, so we then try GET /orgs/{login}.
  let res = await fetch(`${REST_URL}/users/${login}`, {
    method: "GET",
    headers: GITHUB_HEADERS(token),
  });

  if (res.ok) {
    const body = (await res.json()) as { type?: string };
    return body.type === "Organization" ? "org" : "user";
  }

  if (res.status === 404) {
    const orgRes = await fetch(`${REST_URL}/orgs/${login}`, {
      method: "GET",
      headers: GITHUB_HEADERS(token),
    });
    if (orgRes.ok) {
      return "org";
    }
    throw new Error(
      `Could not resolve owner '${login}' (REST /users and /orgs both returned 404).`,
    );
  }

  // Any non-404 non-200 (e.g. 401, 403) is a real failure.
  const detail = await res.text();
  throw new Error(
    `Could not resolve owner '${login}' (REST /users returned ${res.status}): ${detail}`,
  );
}

/**
 * Fetch a GitHub Projects (V2) Kanban board snapshot, paginating through ALL
 * items (cursor-based) so boards larger than one page are not silently
 * truncated. Supports both user-owned and organization-owned projects by
 * probing the owner type first. Requires a token with `read:project` scope; a
 * 403/FORBIDDEN surfaces an explicit scope message.
 */
export async function fetchSprintBoard(
  token: string,
  login: string,
  projectNumber: number,
): Promise<SprintBoardSnapshot> {
  const ownerType = await resolveOwnerType(token, login);
  const query = ownerType === "org" ? ORG_QUERY : USER_QUERY;

  const items: SprintBoardItem[] = [];
  let projectTitle = "";
  let cursor: string | null = null;

  for (;;) {
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: GITHUB_HEADERS(token),
      body: JSON.stringify({
        query,
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
