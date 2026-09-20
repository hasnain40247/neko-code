---
description: Design and write a safe database schema migration
---

# schema-migrate

Use when the user needs to add, alter, or drop a table, column, or index.

## Safety rules (non-negotiable)

1. Never drop a column in the same deploy that removes its code references
2. Never add a NOT NULL column without a DEFAULT or backfill step
3. Never rename a column directly — add new, backfill, cut over, drop old
4. Large table changes (>1M rows) must be done in batches to avoid lock escalation

## Migration template

```sql
-- Migration: <short description>
-- Safe to run: <yes / only during maintenance window>
-- Rollback: <rollback SQL or "manual">

BEGIN;

-- Forward
ALTER TABLE users ADD COLUMN avatar_url TEXT;

COMMIT;
```

## Checklist before applying

- [ ] Index exists on any FK column added
- [ ] Existing rows handle the new column (DEFAULT or backfill)
- [ ] Migration is idempotent (`IF NOT EXISTS`, `IF EXISTS` guards)
- [ ] Rollback plan documented
- [ ] Staging tested first

## Rules

- Always wrap in a transaction unless the DB doesn't support transactional DDL
- Name migrations with a timestamp prefix: `20260101_add_avatar_url.sql`
