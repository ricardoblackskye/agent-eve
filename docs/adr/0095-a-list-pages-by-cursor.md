# 0095: A list pages by cursor, not by offset

Date: 2026-11-23

Status: Accepted

## Context

The run list needed paging. The read API already pages: it takes a size, and answers a page plus an
opaque cursor the client is not meant to read. It reports no total, and the cursor already carries the
run creation time and the run id, which is a total order with the id as the tie-break.

The obvious alternative was an offset and a total. That would have meant a count on every request, in
every store implementation, to answer a question the user interface never asked.

## Decision

A list asks for a page by size, and by the cursor it was handed for any page after the first. The
client holds a stack of cursors and never inspects one, so the store keeps its own cursor shape.
Offsets and totals are not introduced, and the query cache keys on the size and the cursor, which is
what makes a poll re-read the page in view rather than move the reader.

## Consequences

- Back and forward are a stack rather than arithmetic, and a page count cannot be shown because the
  server does not know it. Neither is a loss: the ledger never displayed a page count.
- No count runs per request, and no store implementation has to add one.
- A store change is invisible to the client, because the cursor is opaque and passed through.
- A request that asks by offset is not refused, it is ignored. That is deliberate: an unknown
  parameter costs nothing, while refusing one would break a client for asking a harmless question.
