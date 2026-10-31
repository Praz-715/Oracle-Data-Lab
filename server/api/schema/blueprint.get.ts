import { CORE_TABLES } from '../../generators/blueprint'

/** Blueprint summary for the Schema Designer (no database access). */
export default defineEventHandler(() => ({
  id: 'retail-commerce',
  name: 'Retail Commerce',
  description: 'Customers, catalog, inventory, orders, payments, shipments and returns with realistic constraints.',
  maxExtensionTables: labLimits().maxExtensionTables,
  tables: CORE_TABLES.map((t) => ({
    key: t.key,
    kind: t.kind,
    lobTable: !!t.lobTable,
    comment: t.comment,
    columns: t.columns.map((c) => ({ name: c.name, type: c.type, nullable: !!c.nullable })),
    pk: t.pk,
    uniques: (t.uniques ?? []).map((u) => u.cols),
    checks: (t.checks ?? []).map((c) => c.expr),
    fks: (t.fks ?? []).map((f) => ({ cols: f.cols, ref: f.ref })),
    indexes: (t.indexes ?? []).map((i) => i.cols),
  })),
}))
