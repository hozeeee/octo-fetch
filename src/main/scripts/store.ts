import type { SavedScript, ScriptDraft, ScriptRun, ScriptSummary, ScriptValues } from '../../shared/scripts'
import { randomUUID } from 'node:crypto'
import { copyFile, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { Script } from 'node:vm'
import { z } from 'zod'
import { MAX_RUNS, MAX_SCRIPTS, runSchema, scriptDraftSchema, scriptSchema, valuesSchema } from '../../shared/scripts'
import { atomicWrite, SerialQueue } from '../storage/store'

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const PREFIX = '// @octo-fetch-local '
export const scriptBody = (source: string) => `(async function octoScript() {\n"use strict";\n${source}\n})()`
function encode(script: SavedScript): string {
  const { source, ...draft } = script.draft
  return `${PREFIX}${JSON.stringify({ ...script, draft })}\n${source}`
}
function decode(content: string): SavedScript {
  const end = content.indexOf('\n')
  if (!content.startsWith(PREFIX) || end < 0) throw new Error('脚本文件格式无效')
  const metadata = JSON.parse(content.slice(PREFIX.length, end))
  return scriptSchema.parse({ ...metadata, draft: { ...metadata.draft, source: content.slice(end + 1) } })
}
export class ScriptStore {
  private queue = new SerialQueue()
  private scripts = new Map<string, SavedScript>()
  readonly warnings: string[] = []
  constructor(readonly directory: string, private changed: () => void = () => undefined) {}
  private file(id: string) { return path.join(this.directory, 'scripts', `${z.uuid().parse(id)}.js`) }
  async initialize(): Promise<void> {
    let names: string[]
    try { names = await readdir(path.join(this.directory, 'scripts')) } catch (error) { if (missing(error)) return; throw error }
    for (const name of names.filter((name) => name.endsWith('.js'))) {
      const id = name.slice(0, -3)
      if (!z.uuid().safeParse(id).success) continue
      const load = async (file: string) => {
        const value = decode(await readFile(file, 'utf8'))
        if (value.id !== id) throw new Error('脚本 ID 与文件名不符')
        return value
      }
      try { this.scripts.set(id, await load(this.file(id))) } catch {
        try {
          const recovered = await load(`${this.file(id)}.bak`)
          await copyFile(this.file(id), `${this.file(id)}.corrupt-${Date.now()}`)
          await atomicWrite(this.file(id), encode(recovered))
          this.scripts.set(id, recovered)
          this.warnings.push(`脚本 ${id} 损坏，已恢复备份并保留原文件。`)
        } catch { this.warnings.push(`脚本 ${id} 无法读取，原文件已保留；其他脚本可继续使用。`) }
      }
    }
  }
  list(): ScriptSummary[] {
    return [...this.scripts.values()].map(({ values: _values, draft: { source: _source, ...draft }, ...item }) => structuredClone({ ...item, draft })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  get(id: string): SavedScript {
    const script = this.scripts.get(z.uuid().parse(id))
    if (!script) throw new Error('脚本不存在')
    return structuredClone(script)
  }
  private async write(script: SavedScript): Promise<void> {
    const previous = this.scripts.get(script.id)
    if (previous) await atomicWrite(`${this.file(script.id)}.bak`, encode(previous))
    await atomicWrite(this.file(script.id), encode(script))
    this.scripts.set(script.id, structuredClone(script)); this.changed()
  }
  async save(id: string | undefined, raw: ScriptDraft, origin: SavedScript['origin']): Promise<SavedScript> {
    const draft = scriptDraftSchema.parse(raw)
    // eslint-disable-next-line no-new -- 仅编译脚本以校验语法。
    try { new Script(scriptBody(draft.source)) } catch (error) { throw new Error(`JavaScript 语法错误：${(error as Error).message}`) }
    return this.queue.run(async () => {
      const previous = id ? this.get(id) : undefined
      if (!previous && this.scripts.size >= MAX_SCRIPTS) throw new Error(`最多保留 ${MAX_SCRIPTS} 个脚本`)
      const now = new Date(Math.max(Date.now(), (Date.parse(previous?.updatedAt || '') || 0) + 1)).toISOString()
      const script: SavedScript = { id: previous?.id || randomUUID(), draft, origin, createdAt: previous?.createdAt || now, updatedAt: now, values: {} }
      // 修改变量契约后清除旧参数，避免旧类型/候选项被悄悄带入新版本。
      if (previous && JSON.stringify(previous.draft.variables) === JSON.stringify(draft.variables)) script.values = previous.values
      await this.write(script)
      return structuredClone(script)
    })
  }
  async remember(id: string, revision: string, values: ScriptValues): Promise<void> {
    await this.queue.run(async () => {
      const script = this.get(id)
      if (script.updatedAt !== revision) return
      script.values = valuesSchema.parse(values)
      await this.write(script)
    })
  }
  async remove(id: string): Promise<void> {
    await this.queue.run(async () => {
      this.get(id)
      await rm(this.file(id), { force: true })
      await rm(`${this.file(id)}.bak`, { force: true })
      this.scripts.delete(id); this.changed()
    })
  }
}

// 每个脚本仅保留最近 20 次，每次的日志和结果分别有大小上限。
export class ScriptLogStore {
  private queue = new SerialQueue()
  private cache = new Map<string, ScriptRun[]>()
  constructor(private directory: string) {}
  private file(id: string) { return path.join(this.directory, 'script-logs', `${z.uuid().parse(id)}.json`) }
  private async load(id: string): Promise<ScriptRun[]> {
    if (this.cache.has(id)) return this.cache.get(id)!
    let records: ScriptRun[]
    try { records = z.array(runSchema).max(MAX_RUNS).parse(JSON.parse(await readFile(this.file(id), 'utf8'))) } catch (error) { if (!missing(error)) throw new Error('运行记录无法读取，原文件已保留'); records = [] }
    let recovered = false
    for (const run of records) {
      if (run.scriptId !== id) throw new Error('运行记录所属脚本不匹配')
      if (run.status === 'running') {
        run.status = 'interrupted'; run.error = '上次应用退出时脚本未完成'; run.endedAt = new Date().toISOString(); recovered = true
        if (run.kind === 'injection') run.phase = 'disabled'
        if (run.kind === 'sandbox') { run.phase = 'stopped'; run.endReason = 'interrupted' }
      }
    }
    if (recovered) await atomicWrite(this.file(id), JSON.stringify(records))
    this.cache.set(id, records)
    return records
  }
  async list(id: string): Promise<ScriptRun[]> { return this.queue.run(async () => structuredClone(await this.load(id))) }
  async put(raw: ScriptRun): Promise<void> {
    const run = runSchema.parse(structuredClone(raw))
    await this.queue.run(async () => {
      const current = await this.load(run.scriptId)
      const next = [run, ...current.filter((item) => item.id !== run.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, MAX_RUNS)
      await atomicWrite(this.file(run.scriptId), JSON.stringify(next))
      this.cache.set(run.scriptId, next)
    })
  }
  async clear(id: string): Promise<void> {
    await this.queue.run(async () => { await rm(this.file(id), { force: true }); this.cache.delete(id) })
  }
}
