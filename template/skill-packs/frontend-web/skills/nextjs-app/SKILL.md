---
name: nextjs-app
description: >
  Specialist skill for production Next.js applications. Guides correct
  server/client component boundaries, App Router and Pages Router conventions,
  route handlers, server actions, data-fetching and caching semantics, static
  vs dynamic rendering decisions, middleware behaviour, metadata API usage,
  environment-variable safety, and deployment-safe changes.
  Trigger phrases: "Next.js", "app router", "pages router", "server component",
  "route handler", "server action", "ISR", "revalidate", "middleware",
  "generateMetadata", "RSC", "SSR", "SSG".
  Do NOT use for generic React component work that has no Next.js routing,
  rendering-mode, or data-fetching implications.
license: MIT
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(*)
  - Write
metadata:
  author: garda-agent-orchestrator
  version: 1.0.0
  domain: frontend
  triggers: Next.js, App Router, Pages Router, server component, client component, route handler, server action, ISR, revalidate, middleware, metadata, RSC
  role: specialist
  scope: implementation-and-review
  output-format: code-and-review
  related-skills: code-review, frontend-accessibility, dependency-review
---

# Next.js App

## Core Workflow

1. **Detect router mode.** Check for `app/` directory with `layout.tsx` (App Router) vs `pages/` directory with `_app.tsx` (Pages Router). A project may use both; identify which router owns the changed paths. All subsequent guidance adapts to the active router.
2. **Classify component boundaries.** In App Router, every file is a Server Component by default. Add `'use client'` only when the component uses browser APIs, React state, effects, or event handlers. Never add `'use client'` to a `layout.tsx`, `page.tsx`, or `route.ts` unless strictly required; push client interactivity to the smallest leaf component.
3. **Validate data fetching.** App Router: use `async` Server Components with `fetch()` or direct DB/service calls; verify `cache` and `next.revalidate` options are explicit, not accidentally defaulted. Pages Router: confirm `getServerSideProps`, `getStaticProps`, or `getStaticPaths` return shapes match the page component's props. Never fetch data on the client when it can be fetched on the server.
4. **Audit caching and revalidation.** Check every `fetch()` call for its caching intent: `force-cache` (default in App Router ≤14), `no-store`, or `next: { revalidate: N }`. Confirm `revalidatePath` / `revalidateTag` calls in server actions and route handlers invalidate the correct scope. Verify that `export const dynamic`, `export const revalidate`, and `export const fetchCache` segment configs are intentional and not conflicting.
5. **Review route handlers and server actions.** Route handlers (`route.ts`) must validate input, return correct status codes, and set appropriate headers. Server actions (`'use server'`) must validate and sanitize every argument because they are publicly callable endpoints; never trust client-sent IDs or payloads without authorization checks.
6. **Check middleware.** Verify `middleware.ts` matcher config covers intended paths. Confirm it does not perform heavy computation, database calls, or Node-only APIs (middleware runs on the Edge runtime by default). Ensure redirects and rewrites do not create loops.
7. **Validate metadata and SEO.** Confirm `generateMetadata` or static `metadata` exports produce correct `title`, `description`, `openGraph`, and canonical URL. Check that `robots` and `sitemap.ts` align with intended crawl behaviour. Verify dynamic OG images use `ImageResponse` correctly.
8. **Enforce environment-variable safety.** Only variables prefixed `NEXT_PUBLIC_` are exposed to the browser bundle. Confirm secrets (API keys, DB URLs) never use this prefix. Verify `env` and `serverRuntimeConfig`/`publicRuntimeConfig` in `next.config.*` are correct for the deployment target.
9. **Confirm rendering and deployment safety.** Verify `output` mode in `next.config.*` matches the deployment target (`standalone` for Docker, `export` for static hosts). Check that `edge` vs `nodejs` runtime annotations on routes match infrastructure constraints. Confirm `generateStaticParams` covers expected slugs for statically generated dynamic routes.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Next.js delivery checklist | `references/checklist.md` | Any Next.js feature, route, or rendering change |

## Constraints

- Do not add `'use client'` to a file that can remain a Server Component; push interactivity to the smallest leaf.
- Do not use `fetch()` inside `useEffect` for data that can be fetched in a Server Component or `getServerSideProps`.
- Do not omit cache/revalidation options on `fetch()` calls; every fetch must declare its caching intent explicitly.
- Do not trust arguments in server actions or route handlers without validation and authorization checks.
- Do not call Node-only APIs (`fs`, `process.env` reads beyond build-time, database drivers) in middleware or edge-runtime routes.
- Do not expose secrets via `NEXT_PUBLIC_` environment-variable prefix.
- Treat changes to `next.config.*`, `middleware.ts`, root `layout.tsx`, and segment-level `export const` configs as high-risk; verify they do not break existing routes or caching behaviour.
- Do not mix App Router and Pages Router patterns for the same route path.
