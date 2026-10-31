# datasets/

Reserved for exported dataset definitions and reference-data packs (planned **Dataset Sources** and
**Import Manager** modules).

The built-in **Retail Commerce** blueprint is defined in code, not here:

- `server/generators/blueprint.ts` — tables, columns, keys, checks, indexes
- `server/generators/model.ts` — deterministic row model and business rules
- `server/generators/vocab.ts` — synthetic vocabulary (no real personal data)

Never place real customer data or credentials in this folder.
