---
name: angular-app
description: >
  Specialist skill for production Angular applications (v14+). Guides
  standalone-vs-NgModule architecture detection, signals vs RxJS reactive
  boundaries, router configuration and guards, reactive and template-driven
  forms, dependency injection scope selection, change detection strategy,
  HTTP/data service patterns, state management, accessibility, and
  performance-safe UI changes.
  Trigger phrases: "Angular", "ng", "standalone component", "NgModule",
  "signal", "RxJS", "reactive form", "route guard", "interceptor",
  "change detection", "dependency injection", "lazy load".
  Do NOT use for generic TypeScript or HTML/CSS work that has no
  Angular framework implications.
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
  triggers: Angular, standalone component, NgModule, signal, RxJS, reactive form, route guard, interceptor, change detection, DI, lazy load
  role: specialist
  scope: implementation-and-review
  output-format: code-and-review
  related-skills: code-review, frontend-accessibility, dependency-review
---

# Angular App

## Core Workflow

1. **Detect architecture style.** Check `angular.json` for project type, then inspect `src/main.ts` for `bootstrapApplication` (standalone) vs `platformBrowserDynamic().bootstrapModule` (NgModule). Determine whether the project uses standalone components, NgModules, or a hybrid. All subsequent guidance adapts to the active style.
2. **Enforce component boundaries.** Standalone components must declare their `imports` array explicitly; do not import entire modules when only one component or directive is needed. NgModule projects must keep `declarations`, `imports`, and `exports` minimal and correctly scoped. Never declare a component in more than one module.
3. **Classify reactive patterns.** Distinguish Angular signals (`signal()`, `computed()`, `effect()`, `input()`, `output()`, `model()`) from RxJS observables. Use signals for synchronous, template-bound state. Use RxJS for async streams, HTTP responses, WebSocket data, and complex event composition. Do not mix patterns in the same data flow without explicit `toSignal()` / `toObservable()` bridge calls.
4. **Validate routing.** Inspect `app.routes.ts` or `RouterModule.forRoot()` configuration. Verify lazy-loaded routes use `loadComponent` (standalone) or `loadChildren` (NgModule) correctly. Confirm route guards (`canActivate`, `canDeactivate`, `canMatch`, `resolve`) return proper types and handle async auth checks. Check that wildcard and redirect routes do not shadow valid paths.
5. **Review forms.** Reactive forms: verify `FormGroup` / `FormArray` validators are defined at creation, `updateOn` strategy is intentional, and submitted values are read from the form model—not from template bindings. Template-driven forms: confirm `ngModel` two-way bindings are stable and validation directives are applied. Never mix reactive and template-driven approaches on the same form control.
6. **Audit dependency injection.** Confirm `providedIn: 'root'` is used only for true singletons. Feature services should be provided in the route or component scope. Verify `InjectionToken` usage for interface-based dependencies. Check that `multi: true` providers (interceptors, validators) are ordered intentionally.
7. **Check change detection.** Components with `ChangeDetectionStrategy.OnPush` must receive data through `@Input` / signals or async pipes—not through mutated objects. Verify `markForCheck()` calls are deliberate and scoped. Confirm zone-less code (`provideExperimentalZonelessChangeDetection`) handles manual change detection correctly.
8. **Validate HTTP and data services.** Verify `HttpClient` calls set expected headers, handle errors with `catchError`, and unsubscribe or use `takeUntilDestroyed()`. Confirm functional interceptors (`HttpInterceptorFn`) or class-based interceptors are registered in the correct provider order. Check that API URLs come from environment files, not hard-coded strings.
9. **Confirm build, test, and deployment safety.** Run `ng build` (or equivalent from `40-commands.md`) and verify there are no AOT template errors, circular dependencies, or bundle-size regressions. Run `ng test` and confirm changed components have spec coverage. Verify `angular.json` budgets are not exceeded. Check that environment-specific config (`environment.ts` vs `environment.prod.ts`) does not leak secrets.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Angular delivery checklist | `references/checklist.md` | Any Angular feature, component, or routing change |

## Constraints

- Do not declare a standalone component inside an NgModule `declarations` array—use `imports` instead.
- Do not subscribe to observables in components without ensuring cleanup via `takeUntilDestroyed()`, `async` pipe, or explicit `unsubscribe` in `ngOnDestroy`.
- Do not use `ChangeDetectionStrategy.OnPush` on components that rely on mutable object references without signal or observable push.
- Do not provide singleton services at the component level unless instance-per-component semantics are required.
- Do not hard-code API base URLs; use environment files or injection tokens.
- Do not disable AOT or strict template checking to suppress errors; fix the underlying type issues.
- Treat changes to `angular.json`, root routing config, `main.ts` bootstrap, global interceptors, and `APP_INITIALIZER` providers as high-risk; verify they do not break existing modules or lazy-loaded routes.
- Do not bypass route guards with direct `Router.navigate` calls that skip authorization logic.
