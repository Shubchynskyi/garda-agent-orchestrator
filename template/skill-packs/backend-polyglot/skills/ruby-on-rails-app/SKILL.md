---
name: ruby-on-rails-app
description: >
  Domain skill for Ruby on Rails backend applications.
  Use when the repository contains a Rails app with controllers, models,
  Active Record migrations, background jobs, or API serialization layers.
  Triggers: Rails, RoR, Active Record, Sidekiq, controller, migration, service object.
  Negative triggers: standalone Ruby gems with no Rails dependency, Sinatra-only apps.
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
  triggers: Rails, Ruby on Rails, Active Record, controller, migration, Sidekiq, Devise, Pundit, service object, API serializer
  role: specialist
  scope: implementation
  output-format: code-and-review
  related-skills: orchestration, code-review, dependency-review
---

# Ruby on Rails App

## Core Workflow

1. **Identify project layout** — confirm Rails version, Gemfile stack, test framework (RSpec / Minitest), and actual build/test commands from `40-commands.md` before editing.
2. **Respect layer boundaries** — keep routing, controller params, business logic, persistence, and serialization in distinct layers; extract service objects or form objects when a controller action exceeds simple CRUD.
3. **Strong parameters at the edge** — whitelist params in the controller; never pass raw `params` into models or services.
4. **Active Record discipline** — scope queries in models or query objects; use `includes`/`preload` to prevent N+1; avoid `.all` without pagination; keep raw SQL in Arel or scoped methods, never inline in controllers.
5. **Migration safety** — every migration must be reversible or explicitly marked `irreversible`; avoid data transforms that lock large tables; use `safety_assured` blocks only with documented justification; never rename or remove columns used by running code without a two-phase deploy.
6. **Callbacks sparingly** — prefer explicit service-object calls over `after_save` / `after_commit` chains; document every callback's side-effect scope and failure mode.
7. **Background jobs** — keep job arguments small and serializable; make jobs idempotent; set `retry` and `dead` thresholds; handle `ActiveJob::DeserializationError`.
8. **Authorization** — enforce policy checks (Pundit, Action Policy, or custom gate) in every controller action that mutates state; never rely solely on route-level guards.
9. **Configuration & secrets** — load config via `Rails.application.credentials` or ENV-backed `config_for`; never commit plaintext secrets; validate required ENV vars at boot in an initializer.
10. **Run validations** — execute `bundle exec rails test` (or `bundle exec rspec`), `bundle exec rubocop`, and `bundle exec rails db:migrate:status` before marking work complete.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Delivery checklist | `references/checklist.md` | Any Rails feature, review, or migration task |

## Constraints

- Do not mix request-parameter shaping, domain logic, and persistence in a single controller action.
- Do not add model callbacks that produce invisible side effects outside the aggregate boundary.
- Treat schema migrations, column removals, index additions on large tables, and gem major-version bumps as high-risk changes requiring explicit review.
- Do not silently rescue `StandardError` or broader exceptions; catch only the specific error classes you can meaningfully handle.
- Do not disable Rails defaults (`config.force_ssl`, CSRF protection, parameter filtering) without documented justification.
