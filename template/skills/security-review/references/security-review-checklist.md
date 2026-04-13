# Security Review Checklist

## Authentication and Identity
- Validate token verification and signature checks.
- Validate issuer, audience, and expiration handling.
- Validate session and credential handling paths.

## Authorization
- Validate service-level authorization on protected actions.
- Validate role and permission mapping correctness.
- Validate no privilege escalation path exists in changed code.

## Payments and Webhooks
- Validate payment authorization boundaries.
- Validate webhook authenticity checks and replay protection.
- Validate idempotency behavior for payment callbacks.

## Secrets and Sensitive Data
- Validate no hardcoded secrets.
- Validate no sensitive data in logs or error messages.
- Validate secure configuration sourcing and access controls.

## Checklist Row Template
```text
| rule_id | status | evidence |
|---------|--------|----------|
| SEC-AUTHZ | PASS | backend/.../OrderService.java:54 |
```

## Security Rule IDs
- `SEC-AUTHN-TOKEN-VALIDATION`
- `SEC-AUTHZ-SERVICE-ENFORCEMENT`
- `SEC-PAYMENT-AUTHORIZATION`
- `SEC-WEBHOOK-INTEGRITY`
- `SEC-SECRET-HANDLING`
