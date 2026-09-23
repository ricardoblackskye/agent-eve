import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/**
 * #99 changed the frontend contract: the chat UI is no longer public. An
 * unauthenticated GET of `/` must redirect into the Google sign-in flow
 * (`/api/auth/google/start`), while the browser agent proxy stays reachable on
 * its own Bearer key.
 */
export default defineEval({
  description:
    "Verifies the frontend is behind Google sign-in and the browser agent proxy loads.",
  tags: ["production"],
  async test(t) {
    const response = await t.target.fetch("/");
    t.check(
      response.status,
      satisfies(
        (s: number) => s === 302,
        "unauthenticated home page redirects to sign-in",
      ),
    );
    const location = response.headers.get("location") ?? "";
    t.check(
      location,
      satisfies(
        (l: string) => l.includes("/api/auth/google/start"),
        "redirect targets the Google sign-in flow",
      ),
    );

    const proxyHealth = await t.target.fetch("/api/eve/v1/health");
    t.check(
      proxyHealth.status,
      satisfies((s: number) => s === 200, "browser proxy health returns 200"),
    );
  },
});
