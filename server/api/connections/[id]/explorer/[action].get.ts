import { z } from 'zod'
import {
  dependencies,
  erd,
  exactCount,
  listSchemas,
  listTables,
  objectDdl,
  objectInventory,
  tableDetail,
  tableRows,
} from '../../../../services/explorer'

const q = z.object({
  owner: z.string().default(''),
  table: z.string().default(''),
  name: z.string().default(''),
  type: z.string().default('TABLE'),
  prefix: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})

export default defineEventHandler(async (event) => {
  const id = requireParam(event, 'id')
  const action = requireParam(event, 'action')
  const p = queryAs(event, q)
  switch (action) {
    case 'schemas':
      return listSchemas(id)
    case 'inventory':
      return objectInventory(id, p.owner)
    case 'tables':
      return listTables(id, p.owner)
    case 'table':
      return tableDetail(id, p.owner, p.table)
    case 'rows':
      return tableRows(id, p.owner, p.table, p.page, p.pageSize)
    case 'count':
      return exactCount(id, p.owner, p.table)
    case 'ddl':
      return objectDdl(id, p.owner, p.name || p.table, p.type)
    case 'dependencies':
      return dependencies(id, p.owner)
    case 'erd':
      return erd(id, p.owner, p.prefix || undefined)
    default:
      throw createError({ statusCode: 404, statusMessage: `Unknown explorer action ${action}` })
  }
})
