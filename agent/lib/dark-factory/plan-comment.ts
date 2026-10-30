/**
 * Dark Factory — the plan comment on the ticket (#365, Task 11).
 *
 * The plan only reached the branch, and only after the run had finished. Posting it as a comment right
 * after planning means a reviewer can see the intent BEFORE any code exists, even if the run later fails.
 *
 * The comment is marked so a retry can find its own work: a second run updates the existing comment
 * instead of stacking another one on the ticket.
 *
 * A comment is also NOT a file (#538). The plan's markdown is rendered for a comment before it is posted: the
 * plan's H1 becomes a bold line and every heading below it is demoted one level, so a comment has no page-sized
 * title or section banners; and a prose table cell too wide to read in a table moves BELOW it in full, keyed by
 * the row's first column, rather than being truncated. The plan FILE keeps the markdown it has, because its scale
 * is correct there.
 */

import type { PlanCostEstimate } from "./plan-cost-estimate";

/** The marker identifying this Factory's own plan comment, whatever the plan says. */
/** GitHub's hard limit on a comment body. */
export const GITHUB_COMMENT_LIMIT = 65536;

/** The budget a comment body must stay under. Kept in step with sprint-delivery's own ceiling. */
export const MAX_COMMENT_CHARS = 60000;

/** The marker identifying this Factory's own MACHINE block, which lives in its own comment since #518. */
export const PLAN_BLOCK_MARKER = "<!-- dark-factory:plan-block -->";

export const PLAN_COMMENT_MARKER = "<!-- dark-factory:plan -->";

/** A markdown code fence. A constant because the block writes one and the parser looks for it. */
const FENCE = "```";

/**
 * The collapsed machine-readable block (#365 R4).
 *
 * It is appended LAST and closes the comment, which is what makes parsing unambiguous: `parsePlanFromComment`
 * anchors on the end of the body and on the last opening tag, so plan text containing "<details>" cannot
 * be mistaken for the block.
 */
const DETAILS_OPEN = "<details>";
const DETAILS_CLOSE = "</details>";

/** A comment as the ticket API returns it. */
export interface PlanCommentRecord {
  id: number;
  body?: string | null;
}

/** The subset of the issue writer this module needs, so it can be tested without any network. */
export interface PlanCommentTarget {
  listComments(
    owner: string,
    repo: string,
    issue: number,
  ): Promise<{ ok: boolean; comments?: PlanCommentRecord[]; error?: string }>;
  postComment(
    owner: string,
    repo: string,
    issue: number,
    body: string,
  ): Promise<{ ok: boolean; id?: number; error?: string }>;
  editComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string,
  ): Promise<{ ok: boolean; id?: number; error?: string }>;
}

export interface PostPlanCommentOptions {
  owner: string;
  repo: string;
  issue: number;
  markdown: string;
  /**
   * The plan itself, for the machine (#365 R4).
   *
   * A resumed dispatch is a fresh process with no workspace, so the plan it codes against has to survive
   * the wait on the ticket. The comment carries the human rendering AND this, so the thing the human
   * approved is the thing the resumed run reads back.
   *
   * REQUIRED, not optional (#373). It was optional, the runner omitted it, and the omission compiled and ran:
   * the comment then carried the human markdown with no machine-readable block, so the resumed run could not
   * read back the plan it had posted and stopped. A promise to pass it is not a fix; a compile error is.
   */
  plan: unknown;
  /**
   * The plan's cost estimate (#488), rendered into the human part under the marker.
   *
   * Optional, and absence is meaningful: no estimate renders no section, so a run that could not price
   * its plan still posts a readable comment rather than a placeholder nobody can interpret.
   */
  estimate?: PlanCostEstimate | null;
}

export type PlanCommentResult =
  | {
      ok: true;
      action: "created" | "updated";
      id?: number;
      /** #518: the machine block lives in its own comment, so a successful post returns two ids. */
      blockId?: number;
    }
  | { ok: false; action: "failed"; error: string };

/**
 * The widest a table cell may be in a COMMENT before its content moves below the table (#538).
 *
 * Measured on the real comment (WebFeedPOC#176): the Files table's longest cell was 651 characters while the
 * Acceptance criteria table topped out at 68. 120 is comfortably above an ordinary phrase and far below the
 * observed worst case, so it moves prose and leaves the tables that already read well alone.
 */
export const COMMENT_TABLE_CELL_LIMIT = 120;

/** A cell whose content moved below its table, so the table stays readable and nothing is lost. */
const MOVED_CELL_POINTER = "_(see below)_";

/** The configured cell limit, overridable for a deployment that wants a tighter or looser comment. */
export function commentCellLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.DF_PLAN_COMMENT_CELL_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : COMMENT_TABLE_CELL_LIMIT;
}

/** A markdown table's separator row, which is not a data row. */
const SEPARATOR_ROW = /^\|[\s:-]+\|/;

/**
 * Render the plan's markdown for a COMMENT rather than for a file (#538).
 *
 * Two rules, and nothing else changes - the plan file keeps the markdown it has, because its scale is correct
 * there:
 *
 * 1. **Headings.** A comment has no page title, so the plan's H1 becomes a bold line and every heading below it
 *    is demoted by one level. GitHub sizes an H1 as a page title and an H2 as a section banner, which is what
 *    made a 21,471-character comment read as one giant title followed by five huge headings. Demoting rather
 *    than flattening keeps the plan's own shape: tasks stay under their sections.
 * 2. **Table cells.** A prose cell wider than `limit` stops being a table cell: the row keeps its key and its
 *    other columns, and the full text moves below the table as a list keyed by that key. Truncating would be a
 *    worse lie than a wide table, and the rationale is the useful part.
 *
 * Pure: markdown in, markdown out, so the caller does the one environment read.
 */
export function normalizeCommentMarkdown(
  markdown: string,
  limit: number = COMMENT_TABLE_CELL_LIMIT,
): string {
  const lines = (markdown ?? "").split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    const heading = /^(#{1,6})(\s+)(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] as string).length;
      out.push(
        level === 1
          ? `**${heading[3]}**`
          : `${"#".repeat(Math.min(6, level + 1))}${heading[2]}${heading[3]}`,
      );
      continue;
    }

    if (line.startsWith("|")) {
      const table: string[] = [];
      while (i < lines.length && (lines[i] as string).startsWith("|")) {
        table.push(lines[i] as string);
        i++;
      }
      i--;
      out.push(...boundTableCells(table, limit));
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}

/**
 * Move the wide prose cells of one table out of it, keyed by the row's first column.
 *
 * Conservative on purpose: a row whose cells do not split cleanly into the header's column count is left exactly
 * as it is, because a row we cannot parse is a row we must not rewrite. The key column is never moved - it is
 * what the moved text is filed under, and a long path there is not prose.
 */
function boundTableCells(table: string[], limit: number): string[] {
  const header = table[0] as string;
  const expected = header.split("|").length - 2;
  const moved: { key: string; content: string }[] = [];

  const rows = table.map((row) => {
    if (row === header || SEPARATOR_ROW.test(row)) return row;
    const parts = row.split("|");
    if (parts.length - 2 !== expected || expected < 2) return row;

    for (let c = 2; c <= parts.length - 2; c++) {
      const content = (parts[c] as string).trim();
      if (content.length > limit) {
        moved.push({ key: (parts[1] as string).trim(), content });
        parts[c] = ` ${MOVED_CELL_POINTER} `;
      }
    }
    return parts.join("|");
  });

  if (moved.length === 0) return table;
  return [...rows, "", ...moved.map(({ key, content }) => `- ${key} — ${content}`)];
}

/**
 * The comment body: the marker, then the plan.
 *
 * The marker leads so a human opening the ticket sees the plan immediately; an HTML comment renders as
 * nothing, so putting it first costs no visual noise while making the comment findable by a retry.
 */
export function planCommentBody(
  markdown: string,
  estimate?: PlanCostEstimate | null,
): string {
  // #488: the estimate sits directly under the marker, so whoever decides whether to approve meets the
  // forecast BEFORE committing to read the plan. No estimate, no section - never a placeholder, because
  // a reader cannot tell a placeholder from a measurement (see renderCostEstimateSection).
  const section = renderCostEstimateSection(estimate);
  // #538: the HUMAN rendering is normalised for a comment; the machine payload below is not touched, because a
  // resumed run reads the plan back out of it and the parser anchors on it byte for byte.
  const humanMarkdown = normalizeCommentMarkdown(markdown, commentCellLimit());
  const human = section
    ? `${PLAN_COMMENT_MARKER}\n\n${section}\n\n${humanMarkdown}`
    : `${PLAN_COMMENT_MARKER}\n\n${humanMarkdown}`;
  // #518: the machine block is NOT here any more. Human markdown plus a full machine copy of the same plan
  // exceeded GitHub's comment limit for a large plan, and truncating either half would break #365 - so the
  // block lives in its own comment (planBlockBody) and each half is bounded by construction.
  return human;
}

/** Escape so plan TEXT cannot become plan STRUCTURE: a rationale containing "</details>" would close the block
 * early and one containing a fence would truncate the payload. These are valid JSON escapes that decode back, so
 * the round-trip stays exact. */
function escapeForBlock(json: string): string {
  return json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/`/g, "\\u0060");
}

/**
 * Money as a human reads it: two decimals, never exponent notation (#488).
 *
 * A non-finite value becomes 0 rather than "NaN": this section is cosmetic, and a broken number must
 * not render as nonsense in the one place a human is deciding whether to approve a run.
 */
function formatUsd(usd: number): string {
  const value = Number.isFinite(usd) ? usd : 0;
  return `$${value.toFixed(2)}`;
}

/**
 * The estimate section of the plan comment (#488, epic #453).
 *
 * Returns an empty string when there is no estimate. The ABSENCE of a section is the only honest
 * rendering of an absence: a placeholder ("unknown", "$0") reads as a measurement, and a reader
 * cannot tell a placeholder from a real zero. A COMPUTED estimate is always rendered, including a
 * zero band — suppressing one would make "computed, and zero" indistinguishable from "no estimate",
 * leaving one silence to carry two meanings.
 *
 * The middle figure (`expectedUsd`) is deliberately NOT rendered. It is the single number that reads
 * as a quote, and this is a forecast shown to somebody deciding whether to spend the money.
 */
export function renderCostEstimateSection(
  estimate?: PlanCostEstimate | null,
): string {
  if (!estimate) {
    return "";
  }
  return [
    `**Estimated cost: ${formatUsd(estimate.lowUsd)} – ${formatUsd(estimate.highUsd)}** ` +
      `(class \`${estimate.costClass}\`, confidence \`${estimate.confidence}\`)`,
    "",
    "Advisory only — a forecast from the plan's shape, not a quote. It does not block approval.",
  ].join("\n");
}

export type PlanParseResult =
  | { ok: true; plan: unknown }
  | { ok: false; error: string };

/**
 * Read the plan back out of a plan comment (#365 R4).
 *
 * Fails CLOSED. A comment from before this release carries no block, and a resumed run must stop rather
 * than code against a guessed plan — re-planning would be worse still, because the human approved the plan
 * they read, not a fresh one.
 */
export function parsePlanFromComment(commentBody: string): PlanParseResult {
  return parseMarkedComment(commentBody, PLAN_COMMENT_MARKER, "this comment is not a Dark Factory plan comment");
}

/** The machine block in its own comment (#518) - same block, different marker. */
export function parsePlanBlockComment(commentBody: string): PlanParseResult {
  return parseMarkedComment(commentBody, PLAN_BLOCK_MARKER, "this comment is not a Dark Factory plan block");
}

function parseMarkedComment(commentBody: string, marker: string, notOurs: string): PlanParseResult {
  const body = (commentBody ?? "").replace(/\s+$/, "");
  if (!body.includes(marker)) {
    return { ok: false, error: notOurs };
  }
  if (!body.endsWith(DETAILS_CLOSE)) {
    return {
      ok: false,
      error:
        "the plan comment carries no machine-readable plan (the marker is present, so the comment is ours; the block that carries the plan is missing)",
    };
  }

  const block = body.slice(body.lastIndexOf(DETAILS_OPEN));
  const fence = `${FENCE}json`;
  const fenceAt = block.indexOf(fence);
  if (fenceAt === -1) {
    return { ok: false, error: "the machine-readable plan block has no JSON fence" };
  }
  const afterFence = block.slice(fenceAt + fence.length);
  const closeAt = afterFence.indexOf(FENCE);
  if (closeAt === -1) {
    return { ok: false, error: "the machine-readable plan block is not closed" };
  }

  try {
    return { ok: true, plan: JSON.parse(afterFence.slice(0, closeAt).trim()) };
  } catch (error) {
    return {
      ok: false,
      error: `the machine-readable plan is not valid JSON: ${(error as Error).message}`,
    };
  }
}

/** This Factory's plan comment on a ticket, if it already has one. */
export function findPlanComment(
  comments: PlanCommentRecord[],
): PlanCommentRecord | undefined {
  return comments.find(
    (comment) =>
      typeof comment.body === "string" && comment.body.includes(PLAN_COMMENT_MARKER),
  );
}

/**
 * Post the plan on the ticket, updating this Factory's own comment if it is already there.
 *
 * Returns a result rather than throwing: whether a plan that cannot be posted should stop a run is the
 * caller's policy, not this function's. The runner fails closed on it, because a plan nobody can read
 * before coding is the exact defect this exists to fix.
 */
export async function postPlanComment(
  target: PlanCommentTarget,
  options: PostPlanCommentOptions,
): Promise<PlanCommentResult> {
  // #518 AC4: refuse BEFORE the network, naming the limit. The old failure was a raw 422 from GitHub that
  // named nothing, and the run died on a plan nobody could read.
  const bodies = [
    { label: "the plan comment", body: planCommentBody(options.markdown, options.estimate) },
    { label: "the machine block comment", body: planBlockBody(options.plan) },
  ];
  for (const { label, body } of bodies) {
    if (body.length > MAX_COMMENT_CHARS) {
      return {
        ok: false,
        action: "failed",
        error:
          `${label} would be ${body.length} characters, over the ${MAX_COMMENT_CHARS}-character budget for a ` +
          `GitHub comment (the hard limit is ${GITHUB_COMMENT_LIMIT}). This run stops here rather than posting ` +
          `a comment the API will reject with a 422 that names nothing`,
      };
    }
  }
  const humanBody = bodies[0].body;
  const blockBody = bodies[1].body;

  const listed = await target.listComments(options.owner, options.repo, options.issue);
  if (!listed.ok) {
    return {
      ok: false,
      action: "failed",
      error: `could not read the ticket's comments: ${listed.error ?? "unknown error"}`,
    };
  }
  const comments = listed.comments ?? [];
  const existing = findPlanComment(comments);
  const existingBlock = findPlanBlockComment(comments);

  // The human comment first: it is what a reviewer reads, and it carries the marker this Factory uses to
  // find its own work on a retry.
  let humanId: number | undefined;
  let action: "created" | "updated";
  if (existing) {
    const updated = await target.editComment(options.owner, options.repo, existing.id, humanBody);
    if (!updated.ok) {
      return {
        ok: false,
        action: "failed",
        error: `could not update the plan comment: ${updated.error ?? "unknown error"}`,
      };
    }
    humanId = updated.id ?? existing.id;
    action = "updated";
  } else {
    const posted = await target.postComment(options.owner, options.repo, options.issue, humanBody);
    if (!posted.ok) {
      return {
        ok: false,
        action: "failed",
        error: `could not post the plan comment: ${posted.error ?? "unknown error"}`,
      };
    }
    humanId = posted.id;
    action = "created";
  }

  // Then the machine block (#518). A failure here must stop the run: a plan comment without its block cannot
  // be read back, and a resumed run fails closed on exactly that (#373).
  let blockId: number | undefined;
  if (existingBlock) {
    const updated = await target.editComment(options.owner, options.repo, existingBlock.id, blockBody);
    if (!updated.ok) {
      return {
        ok: false,
        action: "failed",
        error: `the plan comment was ${action} but its machine block was not updated: ${updated.error ?? "unknown error"}`,
      };
    }
    blockId = updated.id ?? existingBlock.id;
  } else {
    const posted = await target.postComment(options.owner, options.repo, options.issue, blockBody);
    if (!posted.ok) {
      return {
        ok: false,
        action: "failed",
        error: `the plan comment was ${action} but its machine block was not posted: ${posted.error ?? "unknown error"}`,
      };
    }
    blockId = posted.id;
  }

  return { ok: true, action, id: humanId, blockId };
}

/**
 * The MACHINE comment (#518): the block alone, in its own comment, because the human comment plus this one
 * together exceed GitHub's limit for a large plan. Both halves stay whole, so the human still approves exactly
 * what the resumed run reads back (#365).
 */
export function planBlockBody(plan: unknown): string {
  return [
    PLAN_BLOCK_MARKER,
    "",
    DETAILS_OPEN,
    "<summary>Machine-readable plan (read back when this run resumes)</summary>",
    "",
    `${FENCE}json`,
    escapeForBlock(JSON.stringify(plan)),
    FENCE,
    "",
    DETAILS_CLOSE,
  ].join("\n");
}

/** This Factory's machine block comment, if the ticket already carries one. */
export function findPlanBlockComment(
  comments: PlanCommentRecord[],
): PlanCommentRecord | undefined {
  return comments.find(
    (comment) => typeof comment.body === "string" && comment.body.includes(PLAN_BLOCK_MARKER),
  );
}

/**
 * Read the plan back from a ticket's comments (#518): the block in its own comment, or a legacy comment that
 * carries both halves in one body.
 */
export function parsePlanFromComments(comments: readonly PlanCommentRecord[]): PlanParseResult {
  const list = [...comments];
  const block = findPlanBlockComment(list);
  if (block?.body) {
    const parsed = parsePlanBlockComment(block.body);
    if (parsed.ok) {
      return parsed;
    }
    return parsed;
  }
  const human = findPlanComment(list);
  if (human?.body) {
    return parsePlanFromComment(human.body);
  }
  return { ok: false, error: "the ticket carries no Dark Factory plan comment" };
}
