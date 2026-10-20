import type { McpLevel } from '../../shared/model'
import type { ScriptRunner } from '../scripts/runner'
import type { Content, Tool } from './tools'
import { z } from 'zod'
import { dataPutSchema, dataQuerySchema, dataRefSchema } from '../../shared/data-store'

// 数据仓库 MCP 工具复用 ScriptRunner.dataStore；source 固定为 agent，代理不能伪造脚本来源。
function dataTool<T extends z.ZodType>(name: string, level: McpLevel, description: string, schema: T,
  run: (scripts: ScriptRunner, args: z.output<T>) => Promise<unknown> | unknown): Tool {
  return {
    name, level, description, input: z.toJSONSchema(schema, { io: 'input' }),
    async run(_manager, raw, scripts): Promise<Content[]> {
      if (!scripts?.dataStore) throw new Error('数据仓库尚未就绪')
      const value = await run(scripts, schema.parse(raw ?? {}))
      return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
    }
  }
}
export const DATA_TOOLS: Tool[] = [
  dataTool('list_data', 'read', '查询数据仓库：返回集合概况与按条件筛选的分页记录。可按 collection/key/tag/kind/scriptId/runId/siteId/search 组合过滤，search 匹配数据 JSON 文本。',
    dataQuerySchema, (scripts, query) => ({ summary: scripts.dataStore!.summary(), ...scripts.dataStore!.page(query) })),
  dataTool('read_data', 'read', '按集合与键读取单条记录，未命中返回 null。带键记录经 set/write_data 去重覆盖。',
    dataRefSchema, (scripts, ref) => scripts.dataStore!.get(ref)),
  dataTool('write_data', 'operate', '写入数据仓库。传 key 时按集合与键去重覆盖（upsert），不传 key 追加为新文档。data 须为 JSON 值，序列化后不超过 64K 字符。',
    dataPutSchema, (scripts, payload) => scripts.dataStore!.dispatch('put', payload, { kind: 'agent' })),
  dataTool('delete_data', 'full', '按集合与键删除单条记录，返回是否命中。不可恢复，需先获得用户授权。',
    dataRefSchema, (scripts, ref) => scripts.dataStore!.dispatch('delete', ref, { kind: 'agent' }))
]
