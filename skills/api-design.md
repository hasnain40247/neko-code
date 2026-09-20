---
description: Design or critique a REST or RPC API — endpoints, types, versioning, errors
---

# api-design

Use when the user wants to design a new API surface or review an existing one.

## Design principles

- Resources are nouns, actions are HTTP verbs — avoid `/getUser`, use `GET /users/:id`
- Pagination is required on any list endpoint from day one
- All timestamps are ISO 8601 UTC strings
- Error bodies always include `code`, `message`, and optionally `details`

## Standard endpoint shape

```
GET    /v1/resources           list (paginated)
POST   /v1/resources           create
GET    /v1/resources/:id       get one
PATCH  /v1/resources/:id       partial update
DELETE /v1/resources/:id       delete
```

## Error response format

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "email is required",
    "details": [{ "field": "email", "issue": "missing" }]
  }
}
```

## Versioning strategy

- Version in the URL path: `/v1/`, `/v2/`
- Never break a version — add a new one
- Deprecate old versions with a `Sunset` response header

## Review checklist

- [ ] Auth required on all non-public endpoints
- [ ] Rate limiting documented
- [ ] All 4xx and 5xx codes enumerated
- [ ] Idempotency key supported on POST if operation is expensive
