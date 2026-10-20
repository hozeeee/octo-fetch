import type { DataOp, DataPage, DataRecord, DataSource, DataSummary } from '../../shared/data-store'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  dataOpSchema, dataPutSchema, dataQuerySchema, dataRecordSchema, dataRefSchema,
  dataSetSchema, MAX_DATA_RECORDS, serializeData
} from '../../shared/data-store'
import { atomicWrite, SerialQueue } from './store'

// 数据仓库：内存 Map 为权威副本，异步防抖落盘；写入同步完成后立即返回，磁盘故障不阻塞脚本。
// 单文件 data-store.json；损坏时保留原文件并告警，避免自动清空脚本数据。
export class DataStore {
  private records = new Map<string, DataRecord>()
  // (collection\u0000key) → id，供带键写入 O(1) 去重覆盖。
  private keyed = new Map<string, string>()
  private queue = new SerialQueue()
  private timer?: NodeJS.Timeout
  private blocked = false
  private dirty = false
  warning?: string
  readonly file: string
  constructor(directory: string, private changed: () => void = () => undefined) { this.file = path.join(directory, 'data-store.json') }

  async initialize(): Promise<void> {
    let content: string
    try { content = await readFile(this.file, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; this.block('数据仓库无法读取，原文件已保留；新写入暂存于内存，请检查数据目录。'); return }
    try {
      const records = z.array(dataRecordSchema).max(MAX_DATA_RECORDS + 100).parse(JSON.parse(content))
      for (const record of records) this.index(record)
      this.trim()
    } catch { this.block('数据仓库内容损坏，原文件已保留；新写入暂存于内存，请检查数据目录。') }
  }
  private block(message: string) { this.blocked = true; this.warning = message; this.changed() }
  private keyOf(collection: string, key: string) { return `${collection}\u0000${key}` }
  private index(record: DataRecord) {
    this.records.set(record.id, record)
    if (record.key !== undefined) this.keyed.set(this.keyOf(record.collection, record.key), record.id)
  }
  private trim() {
    // 内存 Map 保持插入顺序，超出上限时淘汰最旧记录。
    while (this.records.size > MAX_DATA_RECORDS) {
      const oldest = this.records.keys().next().value
      if (oldest === undefined) break
      this.drop(oldest)
    }
  }
  private drop(id: string): boolean {
    const record = this.records.get(id)
    if (!record) return false
    this.records.delete(id)
    if (record.key !== undefined && this.keyed.get(this.keyOf(record.collection, record.key)) === id) this.keyed.delete(this.keyOf(record.collection, record.key))
    return true
  }
  private upsert(collection: string, key: string | undefined, value: unknown, tags: string[] | undefined, source: DataSource): DataRecord {
    // 序列化仅用于校验类型与大小；存储归一化后的 JSON 值。
    const data = JSON.parse(serializeData(value)) as unknown
    const now = new Date().toISOString()
    const existingId = key !== undefined ? this.keyed.get(this.keyOf(collection, key)) : undefined
    const existing = existingId ? this.records.get(existingId) : undefined
    if (existing) {
      // 覆盖时保持插入位置，更新数据、标记与来源。
      existing.data = data; existing.tags = tags ?? existing.tags; existing.source = source; existing.updatedAt = now
      this.persist(); this.changed()
      return structuredClone(existing)
    }
    const record: DataRecord = { id: randomUUID(), collection, key, data, tags: tags ?? [], source, createdAt: now, updatedAt: now }
    this.index(record); this.trim()
    this.persist(); this.changed()
    return structuredClone(record)
  }
  put(payload: unknown, source: DataSource): DataRecord {
    const value = dataPutSchema.parse(payload)
    return this.upsert(value.collection, value.key, value.data, value.tags, source)
  }
  set(payload: unknown, source: DataSource): DataRecord {
    const value = dataSetSchema.parse(payload)
    return this.upsert(value.collection, value.key, value.data, value.tags, source)
  }
  get(payload: unknown): DataRecord | null {
    const ref = dataRefSchema.parse(payload)
    const id = this.keyed.get(this.keyOf(ref.collection, ref.key))
    const record = id ? this.records.get(id) : undefined
    return record ? structuredClone(record) : null
  }
  delete(payload: unknown): boolean {
    const ref = dataRefSchema.parse(payload)
    const id = this.keyed.get(this.keyOf(ref.collection, ref.key))
    if (!id || !this.drop(id)) return false
    this.persist(); this.changed()
    return true
  }
  page(payload: unknown): DataPage {
    const query = dataQuerySchema.parse(payload ?? {})
    const search = query.search?.toLowerCase()
    const matched = [...this.records.values()].reverse().filter((record) =>
      (!query.collection || record.collection === query.collection) &&
      (!query.key || record.key === query.key) &&
      (!query.tag || record.tags.includes(query.tag)) &&
      (!query.kind || record.source.kind === query.kind) &&
      (!query.scriptId || record.source.scriptId === query.scriptId) &&
      (!query.runId || record.source.runId === query.runId) &&
      (!query.siteId || record.source.siteId === query.siteId) &&
      (!search || JSON.stringify(record.data).toLowerCase().includes(search) || (record.key?.toLowerCase().includes(search) ?? false)))
    return { total: matched.length, items: structuredClone(matched.slice((query.page - 1) * query.pageSize, query.page * query.pageSize)) }
  }
  // 客户端删除单条记录（按 id）。
  remove(id: string): boolean {
    if (!this.drop(z.uuid().parse(id))) return false
    this.persist(); this.changed()
    return true
  }
  // 清空整个仓库或指定集合。
  clear(collection?: string): number {
    const target = collection ? [...this.records.values()].filter((record) => record.collection === collection).map((record) => record.id) : [...this.records.keys()]
    for (const id of target) this.drop(id)
    if (target.length) { this.persist(); this.changed() }
    return target.length
  }
  export(filter?: unknown): string {
    // 导出遵循当前筛选（不分页），保留完整记录供迁移或备份。
    const query = dataQuerySchema.parse({ ...(filter && typeof filter === 'object' ? filter : {}), page: 1, pageSize: MAX_DATA_RECORDS })
    return JSON.stringify(this.page(query).items, null, 2)
  }
  summary(): DataSummary {
    const collections = new Map<string, number>()
    const kinds: DataSummary['kinds'] = {}
    for (const record of this.records.values()) {
      collections.set(record.collection, (collections.get(record.collection) || 0) + 1)
      kinds[record.source.kind] = (kinds[record.source.kind] || 0) + 1
    }
    return {
      total: this.records.size,
      collections: [...collections.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200),
      kinds
    }
  }
  // 脚本环境的数据请求统一在此分发；source 由调用方按运行上下文注入，不来自脚本。
  async dispatch(op: DataOp, payload: unknown, source: DataSource): Promise<unknown> {
    switch (dataOpSchema.parse(op)) {
      case 'put': return this.put(payload, source)
      case 'set': return this.set(payload, source)
      case 'get': return this.get(payload)
      case 'delete': return { deleted: this.delete(payload) }
      case 'query': case 'list': return this.page(payload)
    }
  }
  private persist() {
    if (this.blocked) return
    this.dirty = true
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 100)
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined
    await this.queue.run(async () => {
      if (!this.dirty || this.blocked) return
      this.dirty = false
      const snapshot = JSON.stringify([...this.records.values()])
      try { await atomicWrite(this.file, snapshot); if (this.warning?.includes('写入')) this.warning = undefined } catch { this.dirty = true; this.warning = '数据仓库写入失败，最近写入暂存于内存，请检查磁盘空间或权限。'; this.changed() }
    })
  }
}
