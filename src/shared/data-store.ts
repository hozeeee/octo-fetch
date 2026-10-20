import { z } from 'zod'

// 数据仓库存放脚本产生的结构化数据：单文件 JSON，内存权威，异步落盘。
// 混合模型：带 key 的记录按 (collection,key) 去重覆盖，不带 key 的每次写入追加为新文档。
export const MAX_DATA_RECORDS = 5000
export const MAX_DATA_VALUE_BYTES = 65536
export const MAX_DATA_TAGS = 10

export const collectionSchema = z.string().trim().min(1).max(64).regex(/^[a-z][\w-]{0,63}$/i, '集合名须以字母开头，仅含字母、数字、下划线或连字符')
export const dataKeySchema = z.string().trim().min(1).max(200)
export const dataTagSchema = z.string().trim().min(1).max(40)
// 区分不同脚本环境：action/injection/sandbox 来自脚本，agent 来自 MCP，manual 来自客户端。
export const DATA_KIND_LABELS = { action: '行动脚本', injection: '注入脚本', sandbox: '沙箱脚本', agent: 'MCP 代理', manual: '客户端' } as const
export const dataKindSchema = z.enum(['action', 'injection', 'sandbox', 'agent', 'manual'])
export type DataKind = z.infer<typeof dataKindSchema>
// source 由主进程按运行上下文填充，脚本不能伪造。
export const dataSourceSchema = z.object({
  kind: dataKindSchema, scriptId: z.uuid().optional(), scriptName: z.string().max(120).optional(),
  runId: z.uuid().optional(), siteId: z.uuid().optional()
}).strict()
export type DataSource = z.infer<typeof dataSourceSchema>

// JSON 值校验：拒绝函数、symbol、bigint 及非有限数，限制序列化后的字符数。
export function serializeData(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item) => {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' || (typeof item === 'number' && !Number.isFinite(item))) throw new Error('数据必须可以无损转换为 JSON')
    return item
  })
  if (serialized === undefined) throw new Error('数据必须是 JSON 值')
  if (serialized.length > MAX_DATA_VALUE_BYTES) throw new Error(`数据超过 ${MAX_DATA_VALUE_BYTES} 字符上限，请拆分后写入`)
  return serialized
}

export const dataRecordSchema = z.object({
  id: z.uuid(), collection: collectionSchema, key: dataKeySchema.optional(), data: z.unknown(),
  tags: z.array(dataTagSchema).max(MAX_DATA_TAGS).default([]), source: dataSourceSchema,
  createdAt: z.string(), updatedAt: z.string()
}).strict()
export type DataRecord = z.infer<typeof dataRecordSchema>

const tagsInput = z.array(dataTagSchema).max(MAX_DATA_TAGS).optional()
export const dataPutSchema = z.object({ collection: collectionSchema, key: dataKeySchema.optional(), data: z.unknown(), tags: tagsInput }).strict()
export type DataPut = z.infer<typeof dataPutSchema>
export const dataSetSchema = z.object({ collection: collectionSchema, key: dataKeySchema, data: z.unknown(), tags: tagsInput }).strict()
export type DataSet = z.infer<typeof dataSetSchema>
export const dataRefSchema = z.object({ collection: collectionSchema, key: dataKeySchema }).strict()
export type DataRef = z.infer<typeof dataRefSchema>

// 检索过滤：按集合、键、标记、脚本、环境、运行、网站及正文关键字组合筛选。
export const dataFilterSchema = z.object({
  collection: collectionSchema.optional(), key: dataKeySchema.optional(), tag: dataTagSchema.optional(),
  scriptId: z.uuid().optional(), kind: dataKindSchema.optional(), runId: z.uuid().optional(),
  siteId: z.uuid().optional(), search: z.string().trim().max(200).optional()
}).strict()
export type DataFilter = z.infer<typeof dataFilterSchema>
export const dataQuerySchema = z.object({
  collection: collectionSchema.optional(), key: dataKeySchema.optional(), tag: dataTagSchema.optional(),
  scriptId: z.uuid().optional(), kind: dataKindSchema.optional(), runId: z.uuid().optional(),
  siteId: z.uuid().optional(), search: z.string().trim().max(200).optional(),
  page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(20)
}).strict()
export type DataQuery = z.input<typeof dataQuerySchema>
export type DataPage = { items: DataRecord[]; total: number }
export type DataSummary = { total: number; collections: { name: string; count: number }[]; kinds: Partial<Record<DataKind, number>> }

// 脚本环境经各自传输通道发起的数据请求，主进程处理后原路回复。
export const DATA_OPS = ['put', 'set', 'get', 'delete', 'query', 'list'] as const
export const dataOpSchema = z.enum(DATA_OPS)
export type DataOp = z.infer<typeof dataOpSchema>
export type DataRequest = { type: 'data'; id: string; op: DataOp; payload: unknown }
export type DataReply = { type: 'data-reply'; id: string; ok: true; value: unknown } | { type: 'data-reply'; id: string; ok: false; error: string }

export const DATA_STORE_TEMPLATE = `// 数据仓库在行动、注入和沙箱中通过 octo.data 读写，均返回 Promise，需 await。
// 传 key 按 (集合, key) 去重覆盖；不传 key 每次追加为新文档。
await octo.data.set('profile', 'summary', { count: 3, updatedBy: octo.site?.name }, { tags: ['daily'] });
const saved = await octo.data.get('profile', 'summary');
await octo.data.put('events', { at: Date.now(), note: '一次运行' }, { tags: ['run'] });
const page = await octo.data.query({ collection: 'events', tag: 'run', pageSize: 20 });
return { saved, total: page.total };
`
export const DATA_STORE_CONTRACT = `数据仓库：行动、注入和沙箱均可用 octo.data 读写脚本产生的结构化数据；全部方法返回 Promise，必须 await，主进程串行处理保证一致性与去重。数据以 JSON 单文件保存在用户数据目录，明文，非权限隔离，勿写入凭据。每条记录含集合、可选键、JSON 数据、标记数组，以及由主进程按运行上下文填充的来源（脚本、环境、运行、网站），脚本无法伪造来源。
octo.data.set(collection, key, data, {tags?})：按集合与键去重覆盖（upsert）并回读一致；octo.data.put(collection, data, {key?, tags?})：不传 key 时追加为新文档，传 key 等同 set。octo.data.get(collection, key)：读取单条记录或 null；octo.data.delete(collection, key)：删除并返回是否命中。
octo.data.query(filter?) / octo.data.list(collection, filter?)：按 collection/key/tag/scriptId/kind/runId/siteId/search 组合筛选，分页返回 {items,total}，search 匹配数据 JSON 文本。集合名以字母开头，最多 64 字符；键最多 200 字符；标记最多 10 个、每个 40 字符；单条数据序列化后不超过 64K 字符；仓库最多保留最近 ${MAX_DATA_RECORDS} 条，超出淘汰最旧。调用每分钟有限流，超时会拒绝。page.evaluate 网页环境没有 octo.data。`
