# Platform adapters (R6 foundation)

`agent/lib/dark-factory/platform.ts` is the single boundary for host-specific
deployment context and trusted service origins. `DF_PLATFORM_PROVIDER=vercel`
enables Vercel environment mapping, Eve OIDC auth, and Protection bypass;
`generic` uses explicit `DF_DEPLOYMENT_ENV` / `DF_API_BASE_URL` settings and does
not read Vercel-only values. Production must select a provider; unknown or
invalid configuration fails closed. Local development may omit the selector and
uses the generic context. Next.js routes remain HTTP-host adapters; the Dark
Factory core consumes normalized context and provider-neutral contracts.
