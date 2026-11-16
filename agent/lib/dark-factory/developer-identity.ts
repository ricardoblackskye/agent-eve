/**
 * The Developer's static persona prose (#631).
 *
 * GENERATED - do not edit by hand. Edit docs/dark-factory/developer/instructions.md and run
 * `npx tsx scripts/sync-developer-persona.ts`; a drift test fails when the two disagree.
 *
 * The prose lives in markdown OUTSIDE agent/lib because Eve's discovery rejects a bare .md there
 * (see the ADR). This module is what ships it, so there is no runtime file read to be dropped by
 * output tracing.
 *
 * BYTE-IDENTICAL ON PURPOSE: these strings are the exact text the prompt builders emitted before
 * the move. A changed prompt changes model behaviour, so do not reword one without re-recording
 * the golden prompt contract.
 */

export const DEVELOPER_PREAMBLE: string = "You are Eve's Developer Agent. Execute the following ExecutionPlan:";

export const DEVELOPER_TARGET_FILES: string = [
  "For each target file, provide the code to write.",
  "Return a JSON object where keys are relative file paths and values are string file contents.",
  "Example: { \"app/chat.tsx\": \"export ...\", \"tests/chat.test.ts\": \"import ...\" }",
].join("\n");

export const DEVELOPER_PRESERVE_HEADING: string = "### YOU ARE MODIFYING THESE FILES: KEEP THE CODE THAT IS ALREADY IN THEM";

export const PRESERVATION_CONTRACT: string = [
  "Preserve every existing export, import, prop, handler and markup element that the plan does not",
  "ask you to change. Do not delete code you were not asked to change. Never replace a file with a",
  "stub: a shorter file that drops existing behaviour is a failure, not a simplification. Return the",
  "COMPLETE updated file for each. If a whole-file replacement really is the task, the plan must",
  "declare action \"replace\" for that file.",
].join("\n");

export const DEVELOPER_FEEDBACK_HEADING: string = "### YOUR PREVIOUS ATTEMPT FAILED - FIX THAT, DO NOT REPEAT IT";

export const DEVELOPER_FEEDBACK_FOOTER: string = "Return the full corrected contents of every target file, as the JSON object described above.";
