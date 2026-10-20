import type { Config, Cookie, CookieChanges } from '../../shared/model'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { mergeCookies } from '../../shared/cookies'
import { configSchema, cookieChangesSchema, cookieSchema, DEFAULT_MCP_SETTINGS, DEFAULT_SETTINGS, idSchema } from '../../shared/model'

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => undefined)
    return result
  }
}

export async function atomicWrite(file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { mode: 0o600 })
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }).catch(() => undefined) }
}

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }

export class ConfigStore {
  private queue = new SerialQueue()
  private value: Config = configSchema.parse({ schemaVersion: 1, sites: [], settings: { ...DEFAULT_SETTINGS }, mcp: { settings: { ...DEFAULT_MCP_SETTINGS }, tokens: [] }, tasks: [], notifications: [] })
  readonly warnings: string[] = []
  readonly file: string
  constructor(readonly directory: string) { this.file = path.join(directory, 'config.json') }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    let content: string
    try { content = await readFile(this.file, 'utf8') } catch (error) { if (isMissing(error)) return; throw new Error('无法读取本地配置，请检查数据目录权限') }
    try { this.value = configSchema.parse(JSON.parse(content)) } catch {
      try {
        this.value = configSchema.parse(JSON.parse(await readFile(`${this.file}.bak`, 'utf8')))
        await copyFile(this.file, `${this.file}.corrupt-${Date.now()}`)
        await atomicWrite(this.file, JSON.stringify(this.value, null, 2))
        this.warnings.push('配置损坏，已保留原文件并恢复上一份有效备份。')
      } catch { throw new Error('配置及备份无法读取。原数据已保留，请检查数据目录，应用不会自动清空配置。') }
    }
  }

  get(): Config { return structuredClone(this.value) }
  site(id: string) {
    idSchema.parse(id)
    const site = this.get().sites.find((item) => item.id === id)
    if (!site) throw new Error('页面配置不存在')
    return site
  }
  async update(mutator: (draft: Config) => void): Promise<void> {
    return this.queue.run(async () => {
      const draft = this.get()
      mutator(draft)
      const next = configSchema.parse(draft)
      await atomicWrite(`${this.file}.bak`, JSON.stringify(this.value, null, 2))
      await atomicWrite(this.file, JSON.stringify(next, null, 2))
      this.value = next
    })
  }
  profile(id: string): string { return path.join(this.directory, 'profiles', idSchema.parse(id)) }
}

const vaultSchema = z.object({
  version: z.literal(1), snapshot: z.array(cookieSchema), updatedAt: z.string().optional(), pending: cookieChangesSchema.optional()
})
export type VaultData = z.infer<typeof vaultSchema>
export type Encryptor = { encrypt(text: string): Promise<Buffer>; decrypt(data: Buffer): Promise<string> }

// macOS 默认卷大小写不敏感，Electron 自己就在 userData 下存放 Cookies 数据库，
// 因此快照目录不能叫 cookies，否则两者互相覆盖。
const VAULT_DIRECTORY = 'cookie-vault'
const LEGACY_VAULT_DIRECTORY = 'cookies'

export class CookieVault {
  private queues = new Map<string, SerialQueue>()
  constructor(private directory: string, private encryptor: Encryptor) {}
  private file(id: string): string { return path.join(this.directory, VAULT_DIRECTORY, `${idSchema.parse(id)}.enc`) }
  private queue(id: string): SerialQueue {
    if (!this.queues.has(id)) this.queues.set(id, new SerialQueue())
    return this.queues.get(id)!
  }
  // 把旧版本真正建成目录的快照搬到新位置；同名文件（Electron 的 Cookies）不动。
  async initialize(): Promise<void> {
    const legacy = path.join(this.directory, LEGACY_VAULT_DIRECTORY)
    let names: string[]
    try { names = await readdir(legacy) } catch { return }
    const target = path.join(this.directory, VAULT_DIRECTORY)
    await mkdir(target, { recursive: true, mode: 0o700 })
    for (const name of names) {
      if (!name.endsWith('.enc')) continue
      await rename(path.join(legacy, name), path.join(target, name)).catch(() => undefined)
    }
  }
  async read(id: string): Promise<VaultData> {
    let data: Buffer
    try { data = await readFile(this.file(id)) } catch (error) {
      if (isMissing(error)) return { version: 1, snapshot: [] }
      throw new Error(`无法读取加密 Cookie 文件（${(error as NodeJS.ErrnoException).code || '未知错误'}）`)
    }
    try { return vaultSchema.parse(JSON.parse(await this.encryptor.decrypt(data))) } catch { throw new Error('Cookie 解密失败。请检查钥匙串授权；原始文件已保留。') }
  }
  private async write(id: string, data: VaultData): Promise<void> {
    const encrypted = await this.encryptor.encrypt(JSON.stringify(vaultSchema.parse(data)))
    await atomicWrite(this.file(id), encrypted)
  }
  async capture(id: string, cookies: Cookie[], clearPending = false): Promise<VaultData> {
    return this.queue(id).run(async () => {
      const current = await this.read(id)
      if (JSON.stringify(current.snapshot) === JSON.stringify(cookies) && !(clearPending && current.pending)) return current
      const next: VaultData = { ...current, snapshot: cookies, updatedAt: new Date().toISOString() }
      if (clearPending) delete next.pending
      await this.write(id, next)
      return next
    })
  }
  async stage(id: string, changes: CookieChanges): Promise<VaultData> {
    return this.queue(id).run(async () => {
      const current = await this.read(id)
      const old = current.pending || { upsert: [], remove: [] }
      // 保留每个键最终的写入或删除意图，不能从旧快照推断浏览器当前值。
      const upsert = mergeCookies(old.upsert, changes)
      const remove = mergeCookies(old.remove, { upsert: changes.remove, remove: changes.upsert })
      const next = { ...current, pending: { upsert, remove } }
      await this.write(id, next)
      return next
    })
  }
  async clear(id: string): Promise<void> {
    await this.queue(id).run(() => rm(this.file(id), { force: true }))
  }
}

const secretsSchema = z.object({ version: z.literal(1), secrets: z.record(idSchema, z.string().min(1).max(512)) })

// MCP 令牌明文集中存一份密文，供用户随时重新复制；config.json 只保留哈希。
export class SecretVault {
  private queue = new SerialQueue()
  private cache?: Record<string, string>
  readonly file: string
  constructor(directory: string, private encryptor: Encryptor) { this.file = path.join(directory, 'mcp-tokens.enc') }
  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache
    let data: Buffer
    try { data = await readFile(this.file) } catch (error) {
      if (isMissing(error)) return (this.cache = {})
      throw new Error(`无法读取加密令牌文件（${(error as NodeJS.ErrnoException).code || '未知错误'}）`)
    }
    try { this.cache = secretsSchema.parse(JSON.parse(await this.encryptor.decrypt(data))).secrets } catch { throw new Error('令牌解密失败。请检查钥匙串授权；原始文件已保留。') }
    return this.cache
  }
  private async save(secrets: Record<string, string>): Promise<void> {
    const encrypted = await this.encryptor.encrypt(JSON.stringify(secretsSchema.parse({ version: 1, secrets })))
    await atomicWrite(this.file, encrypted)
    this.cache = secrets
  }
  async read(id: string): Promise<string> {
    return this.queue.run(async () => {
      const secret = (await this.load())[idSchema.parse(id)]
      if (!secret) throw new Error('本机已无此令牌的明文，请删除后重新生成')
      return secret
    })
  }
  async write(id: string, secret: string): Promise<void> {
    await this.queue.run(async () => this.save({ ...await this.load(), [idSchema.parse(id)]: secret }))
  }
  async remove(id: string): Promise<void> {
    await this.queue.run(async () => {
      const secrets = { ...await this.load() }
      if (!(id in secrets)) return
      delete secrets[id]
      await this.save(secrets)
    })
  }
}
