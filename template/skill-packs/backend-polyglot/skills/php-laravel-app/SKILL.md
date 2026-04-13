---
name: php-laravel-app
description: Specialist skill for production Laravel applications. Use when task involves Laravel controllers, Eloquent models, FormRequests, middleware, queues/jobs, policies, migrations, or artisan commands. Triggers — Laravel, Eloquent, FormRequest, middleware, artisan, migration, queue, job, policy, Blade. Negative trigger — plain PHP scripts with no Laravel framework, WordPress/Drupal plugins, Symfony-only projects without Laravel.
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
  domain: backend
  triggers: Laravel, Eloquent, FormRequest, artisan, migration, queue, job, policy, middleware, Blade, service provider
  role: specialist
  scope: implementation
  output-format: code-and-review
  related-skills: orchestration, code-review, dependency-review
---

# PHP Laravel App

## Core Workflow

1. Identify Laravel version, PHP version, and project structure (`app/`, `routes/`, `config/`, `database/`) before editing; check `composer.json` for the `laravel/framework` constraint.
2. Keep route files thin — routes declare URI, method, middleware, and controller; controllers orchestrate but delegate business logic to service classes or actions.
3. Validate all input through dedicated `FormRequest` classes; never validate inline in controllers. Use `authorize()` in the FormRequest or a separate `Policy` — not both for the same check.
4. Guard against N+1 queries: use `with()` / `load()` for eager loading, scope heavy reads into query builders or custom Eloquent scopes, and use `preventLazyLoading()` in non-production environments.
5. Order middleware deliberately in `app/Http/Kernel.php` (or `bootstrap/app.php` for Laravel 11+): global → group → route; ensure auth, throttle, and CORS middleware are in the correct groups.
6. Use the service container for cross-cutting dependencies; bind interfaces in a `ServiceProvider` and inject via constructor — avoid `app()` / `resolve()` in business logic.
7. Write migrations that are safe to run on production: never modify a migration that has been deployed; add a new migration instead. Use `down()` only when the rollback is genuinely reversible.
8. Dispatch long-running work to queued jobs (`ShouldQueue`); set `$tries`, `$timeout`, and `$backoff`; handle `failed()` explicitly. Fire events for side-effects, listeners for reactions.
9. Use `Policy` classes for authorization; register them in `AuthServiceProvider` (or rely on auto-discovery). Return `403` via `$this->authorize()` or `Gate::authorize()` — do not hand-roll access checks.
10. Keep secrets in `.env`; reference them only via `config()` helpers, never `env()` outside of `config/*.php` files. Do not hard-code environment-specific values.
11. Run `php artisan test` (or `vendor/bin/phpunit` / `vendor/bin/pest`), `php artisan route:list` for route sanity, and `./vendor/bin/pint` or `php-cs-fixer` if configured, before marking the task complete.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Delivery checklist | `references/checklist.md` | Any Laravel feature, refactor, or review |

## Constraints

- Do not mix request validation, business logic, and persistence in a single controller method; keep controller methods under ~20 lines of orchestration.
- Do not call `env()` at runtime outside `config/*.php`; cached config will return `null` for `env()` calls.
- Do not modify deployed migrations; create a new migration for schema changes.
- Do not execute destructive artisan commands (`migrate:fresh`, `db:wipe`, `key:generate`) in production or in automated agent flows without explicit user confirmation.
- Do not bypass FormRequest validation by accepting raw `$request->all()` into mass-assignment without guarded/fillable protection.
- Do not suppress Eloquent model events or observers silently; document any `withoutEvents` usage.
- Treat middleware reordering, queue connection changes, and Composer dependency upgrades as high-risk changes.
