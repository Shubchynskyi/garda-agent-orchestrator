# Next.js Delivery Checklist

## Router & Routing

- [ ] Active router mode identified (App Router / Pages Router / hybrid).
- [ ] New routes use the correct router's file conventions (`page.tsx` vs `pages/*.tsx`).
- [ ] Dynamic segments (`[slug]`, `[...catchAll]`, `[[...optional]]`) are validated and typed.
- [ ] Parallel routes (`@slot`) and intercepting routes (`(.)`, `(..)`) do not shadow existing routes.
- [ ] `middleware.ts` matcher config covers intended paths without redirect loops.

## Server & Client Components

- [ ] `'use client'` is added only where browser APIs, state, effects, or event handlers are required.
- [ ] Layouts, pages, and route handlers remain Server Components unless strictly necessary.
- [ ] Client interactivity is pushed to the smallest leaf component.
- [ ] No server-only imports (`fs`, `db`, secrets) leak into client component module graph.

## Data Fetching & Caching

- [ ] Every `fetch()` call declares caching intent (`cache`, `no-store`, `next: { revalidate }`) explicitly.
- [ ] Segment-level configs (`export const dynamic`, `export const revalidate`, `export const fetchCache`) are intentional and non-conflicting.
- [ ] `revalidatePath` / `revalidateTag` calls in server actions and route handlers invalidate the correct scope.
- [ ] Pages Router: `getServerSideProps` / `getStaticProps` / `getStaticPaths` return shapes match page props.
- [ ] `generateStaticParams` covers expected slugs for statically generated dynamic routes.

## Server Actions & Route Handlers

- [ ] Server actions (`'use server'`) validate and sanitize every argument.
- [ ] Authorization checks are present; client-sent IDs and payloads are never trusted directly.
- [ ] Route handlers (`route.ts`) return correct status codes and set appropriate headers.
- [ ] `POST` / `PUT` / `DELETE` handlers confirm CSRF-safe invocation context.

## Middleware

- [ ] Middleware does not perform heavy computation, database calls, or Node-only API usage.
- [ ] Redirects and rewrites do not create loops or break existing routes.
- [ ] Matcher patterns are specific; avoid overly broad `/(.*)`-style matchers.

## Metadata & SEO

- [ ] `generateMetadata` or static `metadata` exports produce correct `title`, `description`, and `openGraph`.
- [ ] Canonical URLs and `robots` config align with intended crawl and indexing behaviour.
- [ ] Dynamic OG images using `ImageResponse` render correctly and have alt text.

## Environment Variables

- [ ] Secrets (API keys, DB URLs, tokens) never use the `NEXT_PUBLIC_` prefix.
- [ ] Client-needed values use `NEXT_PUBLIC_` and are available at build time.
- [ ] `env` entries in `next.config.*` do not accidentally expose server-side values.

## Rendering & Deployment

- [ ] `output` mode in `next.config.*` matches deployment target (`standalone`, `export`, or default).
- [ ] `edge` vs `nodejs` runtime annotations match infrastructure capabilities.
- [ ] Static exports do not reference APIs that require a running server (`revalidate`, route handlers).
- [ ] Image domains / `remotePatterns` in `next.config.*` include all referenced external image hosts.
- [ ] Build produces no unexpected warnings about dynamic usage in static-intended pages.
