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
 *
 * Measured against REAL suite output (74,938 characters of a full run): 512 lines carried a case marker and 436 of
 * them were FILE HEADERS, not cases — a grouped run prints one per file. Read naively those become 436 phantom
 * cases, which is the defect above arriving through a different door. The same output showed every case name
 * carrying a trailing duration (`434ms`), so a name compared against a plan's clean name would never match. Both are
 * handled here: a header line states the CURRENT FILE and is not a case, the duration is stripped, and a case the
 * output never attributed to a file stays unattributed rather than being guessed onto one.
 */

/**
 * One test case the run reported.
 *
 * `file` is the spec file the case ran in, when the output grouped cases by file. That is the only place the
 * information exists, and the Definition of Done's criterion match needs it (`tr.testFile === ac.testFile`), so an
 * unattributed case is left WITHOUT a file rather than attributed to a guess.
 */
export interface ExecutedTestCase {
  name: string;
  passed: boolean;
  file?: string;
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

/**
 * A grouped run's file header: a spec path, an optional test count, an optional duration.
 *
 * Anchored on a path-like token with NO spaces, so a long case name can never be mistaken for a header.
 */
const FILE_HEADER = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s+\(\d+\s+tests?\))?(?:\s+\d+(?:\.\d+)?(?:ms|s))?$/;

/** The duration a reporter appends to a case line, which would otherwise defeat a name comparison. */
const TRAILING_DURATION = /\s+\d+(?:\.\d+)?(?:ms|s)$/;

/**
 * Reads every marker-prefixed line: a file header sets the current file, anything else is a case.
 *
 * A header line is NOT recorded as a case — that is the phantom case which would otherwise certify an acceptance
 * criterion — and a summary line carries no marker, so it is never mistaken for one either.
 */
function readMarkerLines(output: string): ExecutedTestCase[] {
  const cases: ExecutedTestCase[] = [];
  let currentFile: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const match = CASE_LINE.exec(line);
    if (!match) continue;
    const remainder = match[2].trim();
    const header = FILE_HEADER.exec(remainder);
    if (header !== null) {
      currentFile = header[1];
      continue;
    }
    const name = remainder.replace(TRAILING_DURATION, "").trim();
    if (name.length === 0) continue;
    cases.push({
      name,
      passed: PASS_MARKERS.includes(match[1]),
      ...(currentFile === undefined ? {} : { file: currentFile }),
    });
  }
  return cases;
}

/**
 * The first source: output that prints one line per case, prefixed with a pass or fail marker, and optionally groups
 * cases under a file header.
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
