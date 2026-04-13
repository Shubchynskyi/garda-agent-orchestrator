# Angular Delivery Checklist

## Architecture & Bootstrap

- [ ] Architecture style identified (standalone / NgModule / hybrid).
- [ ] `main.ts` bootstrap matches the architecture style (`bootstrapApplication` vs `bootstrapModule`).
- [ ] Standalone components declare only the imports they actually use—no bulk module imports.
- [ ] NgModule `declarations`, `imports`, and `exports` are minimal and correctly scoped.
- [ ] No component is declared in more than one module.

## Routing & Navigation

- [ ] Routes are defined in `app.routes.ts` or `RouterModule.forRoot()` / `forChild()` correctly.
- [ ] Lazy-loaded routes use `loadComponent` (standalone) or `loadChildren` (NgModule).
- [ ] Route guards (`canActivate`, `canDeactivate`, `canMatch`, `resolve`) handle async auth properly.
- [ ] Wildcard and redirect routes do not shadow valid paths.
- [ ] Route parameters and query params are validated before use.

## Signals & RxJS

- [ ] Signals (`signal()`, `computed()`, `effect()`) are used for synchronous, template-bound state.
- [ ] RxJS is used for async streams, HTTP responses, and complex event composition.
- [ ] Bridges between signals and observables use explicit `toSignal()` / `toObservable()`.
- [ ] No observable is subscribed without cleanup (`takeUntilDestroyed()`, `async` pipe, or `unsubscribe`).
- [ ] `effect()` does not trigger infinite update loops or write to signals it reads.

## Forms

- [ ] Reactive forms define validators at `FormGroup` / `FormControl` creation.
- [ ] `updateOn` strategy (`change`, `blur`, `submit`) is intentional.
- [ ] Submitted values are read from the form model, not from template bindings.
- [ ] Template-driven forms use stable `ngModel` bindings with validation directives.
- [ ] Reactive and template-driven approaches are not mixed on the same form control.

## Dependency Injection

- [ ] `providedIn: 'root'` is used only for true application-wide singletons.
- [ ] Feature services are scoped to routes or components where appropriate.
- [ ] `InjectionToken` is used for interface-based or config dependencies.
- [ ] `multi: true` providers (interceptors, validators) are registered in the intended order.
- [ ] No circular dependency between services.

## Change Detection

- [ ] `OnPush` components receive data via `@Input`, signals, or `async` pipe—not mutated objects.
- [ ] `markForCheck()` / `detectChanges()` calls are deliberate and scoped.
- [ ] Zone-less applications handle change detection manually where required.
- [ ] No unnecessary `NgZone.run()` wrapping around already-zoned code.

## HTTP & Data Services

- [ ] `HttpClient` calls handle errors with `catchError` and do not swallow failures silently.
- [ ] Interceptors (functional `HttpInterceptorFn` or class-based) are registered in correct order.
- [ ] API base URLs come from environment files or injection tokens—not hard-coded strings.
- [ ] Auth tokens are attached via interceptors, not duplicated in every service call.
- [ ] Long-lived subscriptions in services are cleaned up on destroy.

## Build, Test & Deployment

- [ ] `ng build` (or project build command) completes without AOT errors or circular dependency warnings.
- [ ] Changed components have corresponding `.spec.ts` test coverage.
- [ ] `angular.json` bundle budgets are not exceeded.
- [ ] `environment.ts` / `environment.prod.ts` do not leak secrets or internal URLs.
- [ ] Service worker config (`ngsw-config.json`) is updated if asset caching routes changed.

## Accessibility & Performance

- [ ] Interactive elements have keyboard support and ARIA attributes where needed.
- [ ] `trackBy` is used on `*ngFor` / `@for` loops over large or dynamic collections.
- [ ] Heavy computations are not performed inside template expressions.
- [ ] Images use `NgOptimizedImage` or explicit `width`/`height` to prevent layout shift.
