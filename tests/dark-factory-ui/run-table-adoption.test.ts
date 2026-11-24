/**
 * #748 task 2 — RunTable is built on a table model, not on a hand-rolled map.
 *
 * TanStack Table is headless: it renders nothing, so the adoption is wiring rather than output. What it
 * buys is the model — column definitions, stable row ids, and manual paging and filtering, which is what
 * lets the server own both. The last case is the load-bearing one: enabling a client row model would give
 * the table its own sorting and filtering and put it in conflict with the server's answer.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.resolve(process.cwd(), "app/dark-factory/ui/components.tsx"),
  "utf8",
);
const table = source.slice(source.indexOf("export function RunTable"));

describe("#748 RunTable is built on a table model", () => {
  it("builds a table rather than mapping rows by hand", () => {
    expect(table).toMatch(/useLegacyTable|useReactTable\(/);
  });

  it("keys every row by its run id, so a row cannot be re-keyed by paging", () => {
    expect(table).toMatch(/getRowId/);
    expect(table).toMatch(/runRowId/);
  });

  it("leaves paging, filtering and sorting to the server", () => {
    expect(table).toMatch(/manualPagination:\s*true/);
    expect(table).toMatch(/manualFiltering:\s*true/);
    expect(table).toMatch(/manualSorting:\s*true/);
  });

  it("enables no client row model, which would fight the server for the same job", () => {
    expect(table).not.toMatch(/getSortedRowModel|getFilteredRowModel|getPaginationRowModel/);
  });
});
