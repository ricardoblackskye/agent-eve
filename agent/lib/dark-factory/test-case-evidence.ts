/**
 * Dark Factory — which test cases did a run ACTUALLY execute, and how did each go? (#764)
 *
 * The Definition of Done certifies an acceptance criterion against a NAMED test case, so it needs evidence that the
 * case ran. Nothing captured that: the coding gate returns a boolean, so the runner recorded a passing result for
 * every criterion the plan mapped (`scripts/dark-factory-runner.ts:2556`) — an assumption presented as evidence, and
 * the reason a `done` verdict could certify criteria whose tests were never written.
 *
 * This is the seam that supplies the missing evidence. It is deliberately NOT a runner-specific parser: everything
 * built in the Factory is provider- and repo-agnostic by default, and a parser keyed to one runner's output format
 * would put that runner into the invariant. A source here is described by the SHAPE it recognises, with the first
 * implementation proving the rule rather than defining it; a differently-shaped runner is added alongside rather
 * than rewriting the caller.
 *
 * The load-bearing property is the negative one: `parseExecutedTestCases` returns NO cases when it cannot read the
 * output, and a caller must fail closed on that. A parse that invented a case would reintroduce the defect.
 */

/** One test case the run reported. */
export interface ExecutedTestCase {
  name: string;
  passed: boolean;
}

/** One recognized evidence format. */
export interface TestCaseEvidenceSource {
  /** Short name, so a run's log can say which source read its output. */
  readonly name: string;
  /** True when this source recognises the output AT ALL — the gate for attributing the evidence. */
  recognises(output: string): boolean;
  /** The cases the output reports. Never invents one: unreadable output yields an empty list. */
  parse(output: string): ExecutedTestCase[];
}

/** Pass and fail markers a per-case line may carry. Unicode literals, matched as data. */
const PASS_MARKERS = "\u2713\u2714\u221a";
const FAIL_MARKERS = "\u00d7\u2717\u2718";
const CASE_LINE = new RegExp(`^[ \t]*([${PASS_MARKERS}${FAIL_MARKERS}])[ \t]+(.+?)[ \t]*$`);

/** Reads every marker-prefixed case line; anything else in the output is not a case. */
function readMarkerLines(output: string): ExecutedTestCase[] {
  const cases: ExecutedTestCase[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = CASE_LINE.exec(line);
    if (!match) continue;
    const name = match[2].trim();
    if (name.length === 0) continue;
    cases.push({ name, passed: PASS_MARKERS.includes(match[1]) });
  }
  return cases;
}

/**
 * The first source: output that prints one line per case, prefixed with a pass or fail marker.
 *
 * Described by that shape rather than by a tool, so any runner emitting it is covered. Notably it does NOT read a
 * summary line ("3 passed") as a case — that is the line a naive parser turns into a phantom case, which would then
 * certify an acceptance criterion.
 */
export const MARKER_LINE_SOURCE: TestCaseEvidenceSource = {
  name: "marker-line",
  recognises: (output) => readMarkerLines(output).length > 0,
  parse: readMarkerLines,
};

/** Every source known to the Factory, tried in order. */
export function testCaseEvidenceSources(): readonly TestCaseEvidenceSource[] {
  return [MARKER_LINE_SOURCE];
}

/**
 * The cases the output reports, read by the first source that recognises it.
 *
 * Returns an empty list when no source can read the output — the caller must treat that as NO EVIDENCE and fail
 * closed, never as a pass.
 */
export function parseExecutedTestCases(output: string): ExecutedTestCase[] {
  for (const source of testCaseEvidenceSources()) {
    if (source.recognises(output)) return source.parse(output);
  }
  return [];
}
