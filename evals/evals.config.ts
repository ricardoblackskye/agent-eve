import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  // No judge model needed for deterministic smoke tests
  // Add reporters here when needed (e.g. Braintrust)
});