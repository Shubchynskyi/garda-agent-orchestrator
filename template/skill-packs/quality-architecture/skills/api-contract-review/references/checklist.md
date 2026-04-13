# API Contract Review Checklist

## Schema Correctness

- [ ] Request body fields match spec types, names, and nullability.
- [ ] Response body fields match spec types, names, and nullability.
- [ ] Default values in spec are honoured by handler implementation.
- [ ] Collection fields use correct wrapper type (`array` vs single item).
- [ ] Date/time fields declare format (`date-time`, `date`, Unix epoch) consistently.

## Backward Compatibility

- [ ] No response field removed or renamed without version bump.
- [ ] No request field changed from optional to required.
- [ ] No enum value removed from a response field.
- [ ] No type narrowing on existing request or response field.
- [ ] No endpoint removed or path changed without deprecation window.

## Versioning

- [ ] Breaking changes gated behind a new API version (URL, header, or media-type).
- [ ] Additive changes (new optional fields, new endpoints) do not bump version unnecessarily.
- [ ] Deprecated fields/endpoints annotated with target removal version.

## Error Shapes

- [ ] All error responses use the project's standard envelope (`code`, `message`, `details`).
- [ ] Status codes are semantically correct (400 validation, 401 auth, 403 authz, 404 not found, 409 conflict, 422 unprocessable, 429 rate limit, 5xx server).
- [ ] No endpoint returns 200 for logical failures.

## Pagination & Filtering

- [ ] Paginated endpoints use stable cursor or deterministic offset.
- [ ] Page size has a documented upper bound.
- [ ] Filter/sort parameters are validated; unknown values return 400.

## Idempotency

- [ ] Mutating POST/PUT endpoints accept or generate an idempotency key where applicable.
- [ ] Retry of the same idempotent request returns the original response, not a duplicate side-effect.

## Test Coverage

- [ ] Contract-level or consumer-driven tests exist for each changed endpoint.
- [ ] Tests assert on status code, required response fields, and error shapes.
- [ ] Edge cases covered: empty collections, max pagination, invalid filters, expired cursors.
