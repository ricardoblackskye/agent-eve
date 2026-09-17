/**
 * Pure quality grading — the L2 (quality) gate from the #121/#122 benchmark
 * foundation, now importable by PRODUCTION code.
 *
 * It previously lived only in `tests/helpers/model-bench.ts`, which production
 * modules cannot import (pulling the test tree into the app bundle). The
 * self-improvement controller (#146) must MEASURE a candidate change against a
 * fixed, deterministic benchmark, so the pure half moved here and the test
 * helper re-exports it unchanged — existing callers keep working, and the
 * controller reuses the SAME gate rather than inventing a parallel one.
 *
 * Deliberately offline: no network, no API key. The live latency measurement
 * stays in the test helper, where a key can be required.
 */

export interface QualityGate {
  /** Minimum non-whitespace character count (guards against truncated stubs). */
  minChars: number;
  /** Required section markers (case-insensitive) the output must contain. */
  requiredSections: string[];
  /** Substrings that indicate a refusal / error (output disqualifies). */
  refusalMarkers: string[];
}

export interface QualityResult {
  passed: boolean;
  failures: string[];
}

/**
 * Pure: grade a model's story-style output against capability gates.
 * A model "degraded" if it refuses, errors, or can no longer produce the
 * structured sections the agent depends on.
 */
export function gradeStoryQuality(
  text: string,
  gate: QualityGate,
): QualityResult {
  const failures: string[] = [];
  const trimmed = text.trim();

  if (trimmed.length < gate.minChars) {
    failures.push(
      `output too short (${trimmed.length} chars < ${gate.minChars}) — possible truncation/refusal`,
    );
  }

  const lower = trimmed.toLowerCase();
  for (const marker of gate.refusalMarkers) {
    if (lower.includes(marker.toLowerCase())) {
      failures.push(`output contains refusal/error marker: "${marker}"`);
    }
  }

  for (const section of gate.requiredSections) {
    if (!lower.includes(section.toLowerCase())) {
      failures.push(`missing required section marker: "${section}"`);
    }
  }

  return { passed: failures.length === 0, failures };
}
