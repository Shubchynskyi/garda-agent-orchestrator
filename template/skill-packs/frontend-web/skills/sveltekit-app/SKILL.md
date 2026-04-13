---
name: sveltekit-app
description: >
  Specialist skill for production SvelteKit applications. Guides correct
  load-function design, form actions, +page/+layout/+server file conventions,
  server/client module boundaries, hooks behaviour, invalidation and navigation
  semantics, adapter selection, environment-variable safety, and accessible,
  performance-safe UI changes.
  Trigger phrases: "SvelteKit", "load function", "form action", "+page",
  "+layout", "+server", "hooks.server", "adapter", "invalidate", "prerender",
  "progressive enhancement", "superforms".
  Do NOT use for generic Svelte component or library authoring that has no
  SvelteKit routing, data-loading, or server interaction implications.
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
  triggers: SvelteKit, load function, form action, +page, +layout, +server, hooks, adapter, invalidate, prerender, SSR, endpoint, progressive enhancement
  role: specialist
  scope: implementation-and-review
  output-format: code-and-review
  related-skills: code-review, frontend-accessibility, dependency-review
---

# SvelteKit App

## Core Workflow

1. **Identify routing structure.** Confirm the project uses `src/routes/` with SvelteKit's file-based routing. Note whether route groups `(group)`, dynamic `[param]`, rest `[...rest]`, and optional `[[optional]]` segments are in play. Check `svelte.config.*` for any `routes` or `alias` overrides.
2. **Classify each route file.** Understand the role of every `+` file in the changed route: `+page.svelte` (UI), `+page.ts` (universal load), `+page.server.ts` (server-only load and form actions), `+layout.svelte` / `+layout.ts` / `+layout.server.ts` (shared wrappers), `+server.ts` (standalone API endpoint), `+error.svelte` (error boundary). Never put server-only logic in `+page.ts` or `+layout.ts`; those modules run in the browser during client-side navigation.
3. **Validate load functions.** Ensure each `load` function returns a plain serialisable object. Server loads (`+page.server.ts`) may access databases, secrets, and `event.locals`; universal loads (`+page.ts`) must not. Confirm parent data access uses `await parent()` only when necessary and does not create waterfall chains. Check that `depends()` keys match any later `invalidate()` calls.
4. **Audit form actions.** Form actions in `+page.server.ts` must validate and sanitize every field from `request.formData()`. Return `fail(status, data)` for validation errors and redirect with `redirect(status, url)` for success. Verify that destructive actions require explicit confirmation or CSRF-safe tokens. Confirm client-side `use:enhance` callbacks do not suppress server-returned validation data.
5. **Review API endpoints.** `+server.ts` handlers must validate input, set correct status codes and `Content-Type` headers, and handle all expected HTTP methods. Methods not exported should naturally return `405`. Ensure endpoints do not leak secrets in response bodies or headers.
6. **Check hooks.** `hooks.server.ts` `handle` hook: verify the `resolve` call is always reached or intentionally short-circuited. Confirm `handleFetch`, `handleError`, and `event.locals` typing in `app.d.ts` are consistent. `hooks.client.ts` `handleError`: ensure it does not expose stack traces to users.
7. **Enforce server/client module boundaries.** Files under `src/lib/server/` must never be imported from client or universal code; SvelteKit enforces this at build time but agents must not introduce such imports. Confirm `$env/static/private` and `$env/dynamic/private` are used only in server contexts. Public env uses `$env/static/public` or `$env/dynamic/public`.
8. **Validate rendering and adapter config.** Check per-page `export const prerender`, `export const ssr`, `export const csr` annotations for correctness. Verify the adapter in `svelte.config.*` matches the deployment target (`adapter-auto`, `adapter-node`, `adapter-static`, `adapter-vercel`, `adapter-cloudflare`, etc.). Confirm `paths.base` and `paths.assets` are correct for the hosting environment.
9. **Confirm accessibility and progressive enhancement.** Forms must work without JavaScript (`use:enhance` adds progressive enhancement, not replaces it). Confirm navigation transitions do not lose focus management. Verify `<a>` elements use `href` for navigable routes instead of programmatic `goto()` where possible. Check that loading states use appropriate ARIA live regions.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| SvelteKit delivery checklist | `references/checklist.md` | Any SvelteKit feature, route, or rendering change |

## Constraints

- Do not put server-only code (database calls, secret access, `event.locals`) in universal load files (`+page.ts`, `+layout.ts`); use `+page.server.ts` / `+layout.server.ts` instead.
- Do not import from `$env/static/private`, `$env/dynamic/private`, or `$lib/server/` in client or universal modules.
- Do not omit input validation in form actions or `+server.ts` handlers; every user-supplied value must be validated.
- Do not return non-serialisable data (functions, class instances, Dates) from `load` functions.
- Do not suppress `use:enhance` server responses or skip `fail()` returns for validation errors.
- Do not use `goto()` where an `<a href>` provides correct navigable semantics and accessibility.
- Treat changes to `svelte.config.*`, `hooks.server.ts`, root `+layout.server.ts`, adapter config, and `app.d.ts` as high-risk; verify they do not break existing routes, authentication, or rendering behaviour.
- Do not mix `prerender = true` with server-dependent logic (form actions, dynamic `event.locals` reads) on the same route.
