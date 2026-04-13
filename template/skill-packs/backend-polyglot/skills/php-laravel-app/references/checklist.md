# PHP Laravel App Checklist

## Runtime Surface

- [ ] Confirm Laravel and PHP versions from `composer.json` and verify actual test or build commands.
- [ ] Validate all input via `FormRequest` classes and reject invalid payloads with structured 422 responses.
- [ ] Ensure controllers are thin orchestrators; business logic lives in services, actions, or domain classes.

## HTTP Boundaries & Security

- [ ] Verify middleware ordering in Kernel (or `bootstrap/app.php`): auth, throttle, CORS, and trusted proxies are in the intended groups.
- [ ] Confirm authorization uses `Policy` or `Gate`; no hand-rolled access checks are scattered through controllers.
- [ ] Ensure mass-assignment protection exists: models define `$fillable` or `$guarded`; no raw `$request->all()` into `create()` or `update()`.

## Data & Queues

- [ ] Check Eloquent queries for N+1 by confirming `with()` or `load()` on relationship-heavy reads.
- [ ] Review migrations: do not edit already-deployed migrations; `down()` is genuinely reversible or the operational rollback is documented.
- [ ] Verify queued jobs set `$tries`, `$timeout`, `$backoff`, and implement `failed()` handling where recovery matters.

## Configuration & Operations

- [ ] Confirm `env()` is called only inside `config/*.php`; application code should use `config()` exclusively.
- [ ] Check cache, queue, mail, and filesystem drivers for environment-specific behavior or permission drift.
- [ ] Validate logging, Horizon or queue visibility, and health or smoke checks for changed runtime paths.

## Validation & Tooling

- [ ] Run `php artisan test` (or the configured PHPUnit or Pest command) with zero new failures.
- [ ] Run `pint`, `php-cs-fixer`, or the configured style tool if present and confirm zero new violations.
- [ ] Add feature or integration coverage when the task changes authorization, queues, or persistence behavior.
