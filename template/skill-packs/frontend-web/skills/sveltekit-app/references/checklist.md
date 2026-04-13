# SvelteKit Delivery Checklist

## Routing & File Conventions

- [ ] New routes use correct `+` file conventions (`+page.svelte`, `+page.ts`, `+page.server.ts`, `+server.ts`).
- [ ] Dynamic segments (`[param]`, `[...rest]`, `[[optional]]`) are validated and typed via `src/params/` matchers where needed.
- [ ] Route groups `(group)` are used for layout boundaries, not for URL structure changes.
- [ ] `+error.svelte` boundaries exist at appropriate nesting levels.

## Load Functions

- [ ] Server loads (`+page.server.ts`, `+layout.server.ts`) handle secrets, DB access, and `event.locals`.
- [ ] Universal loads (`+page.ts`, `+layout.ts`) contain no server-only logic and return serialisable data.
- [ ] `await parent()` is used sparingly; no waterfall chains between nested loads.
- [ ] `depends()` keys are consistent with any `invalidate()` or `invalidateAll()` calls.
- [ ] Errors in load functions use `error(status, message)` from `@sveltejs/kit`.

## Form Actions

- [ ] Every field from `request.formData()` is validated and sanitized.
- [ ] Validation failures return `fail(status, data)` with actionable error messages.
- [ ] Successful mutations redirect with `redirect(status, url)`.
- [ ] Destructive actions require confirmation or CSRF-safe tokens.
- [ ] Client-side `use:enhance` does not suppress server-returned validation data.

## API Endpoints (+server.ts)

- [ ] Input is validated; response uses correct status codes and `Content-Type` headers.
- [ ] Unexported HTTP methods naturally return `405`.
- [ ] No secrets leak in response bodies or headers.
- [ ] Streaming responses (`ReadableStream`) are properly closed on error.

## Hooks

- [ ] `hooks.server.ts` `handle`: `resolve(event)` is always reached or intentionally short-circuited.
- [ ] `handleFetch` does not expose internal service credentials to external origins.
- [ ] `handleError` does not expose stack traces; returns a safe error shape.
- [ ] `event.locals` type in `app.d.ts` matches actual usage.

## Server/Client Module Boundaries

- [ ] No imports from `$lib/server/` in client or universal modules.
- [ ] `$env/static/private` and `$env/dynamic/private` are used only in server contexts.
- [ ] Public environment values use `$env/static/public` or `$env/dynamic/public`.
- [ ] Secrets (API keys, DB URLs, tokens) never appear in client-reachable modules.

## Rendering & Adapter Config

- [ ] Per-route `export const prerender`, `export const ssr`, `export const csr` are intentional and non-conflicting.
- [ ] Prerendered routes contain no server-dependent logic (form actions, dynamic locals reads).
- [ ] Adapter in `svelte.config.*` matches deployment target (`adapter-node`, `adapter-static`, `adapter-vercel`, `adapter-cloudflare`, etc.).
- [ ] `paths.base` and `paths.assets` are correct for the hosting environment.
- [ ] Build produces no unexpected warnings about missing prerender entries or dynamic usage.

## Accessibility & Progressive Enhancement

- [ ] Forms work without JavaScript; `use:enhance` adds progressive enhancement, not replaces it.
- [ ] `<a href>` is used for navigable routes; `goto()` is reserved for programmatic-only navigation.
- [ ] Loading and transition states use appropriate ARIA live regions or announcements.
- [ ] Focus management is preserved across client-side navigations and form submissions.
