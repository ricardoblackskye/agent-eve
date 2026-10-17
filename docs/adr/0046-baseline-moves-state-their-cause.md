# 0046 — A baseline re-record states whether the floor moved, or the measurement did

- **Date:** 2026-10-18
- **Status:** Accepted

## Context

The coverage ratchet (#391) fails a build when coverage DROPS below a committed floor (`coverage-baseline.json`).
Changing that floor produces a diff containing nothing but four numbers, and **two very different events produce
the same diff**:

- **the coverage moved** — tests were added or removed, code changed; this is progress or regression;
- **the measurement moved** — a different platform, a skipped suite, a different provider, a widened `include`
  glob; this is a correction of the instrument, not of the thing measured.

A reader cannot tell which from the diff. That matters because the two invite opposite readings: the first is good
news, the second means the previous floor was never a valid floor. A number rising with no accompanying test change
reads like a bar moved to make a build pass, which is the reading to avoid.

This is not hypothetical. The committed floor sat **7 lines below** what CI measured for the *same commit*, because
it had been recorded on Windows while the gate runs on Linux. The underlying divergence — one file whose covered
lines differed by platform — was removed in #394 and #396. Re-recording then raised the floor by **8 lines: 7 of
them the platform correction, 1 of them new cases.**

## Decision

- **The floor is recorded from the environment the gate runs in.** A floor measured anywhere else is an assumption
  about that environment, and an assumption that silently reduces the gate's strength. Here that means with the
  five Postgres test variables set, because without them the gated integration suites SKIP and every metric reads
  about 5 points low.
- **A re-record names its cause.** The commit message states whether the coverage moved or the measurement did. The
  two are not interchangeable and the diff cannot express the difference.
- **A floor that disagrees with its own platform is a defect in the gate, not a tolerance to widen.** The correct
  response to "CI always reports a small improvement" is to fix the measurement, never to leave the floor low
  because a low floor is safer. A floor below reality silently permits the coverage loss it exists to prevent.
- **A re-record must be shown to leave the gate biting.** After changing the floor, the gate is proven to still
  exit non-zero on a simulated drop, not merely to pass. Raising a floor is exactly the moment a gate can be
  neutered, and a gate that no longer fails is indistinguishable from no gate.

## Consequences

- The floor's history is readable: every move says whether coverage changed or the instrument did.
- Recording the floor from the gate's own platform means the floor and the gate can no longer disagree, which
  removes a permanent false "Coverage improved" message that would otherwise appear on every run.
- **Zero headroom is accepted deliberately.** With the floor at the measured value, the percentage-point tolerance
  absorbs ordinary wobble (a few lines) and a real drop fails. The floor is a ratchet, not a target: it is meant to
  hold, not to be cleared.
- Coverage remains a proxy for test quality. Nothing here says a high number is good; it says the number must be
  measured honestly before it is relied on.
