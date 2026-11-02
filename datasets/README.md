# datasets/

Files the **Dataset Sources** and **Import Manager** pages can load into lab schemas.

- Put CSV/TSV/XLSX files anywhere under this folder (e.g. `raw/`). They are read-only for the app and
  are listed on the Dataset Sources page. `raw/` is git-ignored — keep large files local.
- `*.bundle.json` manifests describe multi-file dataset packs (table names, column renames/types,
  primary keys, foreign keys, indexes). `olist.bundle.json` loads the
  [Olist Brazilian E-Commerce](https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce) files from
  `raw/` (license CC BY-NC-SA 4.0) into 9 related tables.
- Files uploaded through the UI are stored in `.data/uploads/`, not here.

The built-in synthetic **Retail Commerce** blueprint is defined in code:
`server/generators/blueprint.ts`, `model.ts` and `vocab.ts` (no real personal data).

Never place credentials in this folder. Only import personal data you are allowed to use in a lab.
