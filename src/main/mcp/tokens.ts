import type { McpLevel, McpToken, TokenDraft, TokenSecret } from '../../shared/model'
import type { ConfigStore, SecretVault } from '../storage/store'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { MAX_TOKENS, tokenDraftSchema } from '../../shared/model'

const LEVELS: Record<McpLevel, number> = { read: 0, operate: 1, full: 2 }
export function permits(granted: McpLevel, required: McpLevel): boolean { return LEVELS[granted] >= LEVELS[required] }
export function fingerprint(secret: string): string { return createHash('sha256').update(secret).digest('hex') }
export type Outcome = 'ok' | 'error' | 'denied'
type Usage = { calls: number; errors: number; denied: number; lastUsedAt: string; lastTool?: string }
function mint(): string { return `octo_${randomBytes(32).toString('base64url')}` }

// 身份由本应用生成：明文只交给用户粘贴到接入端，配置里留哈希、别名、等级和调用统计。
export class TokenRegistry {
  private pending = new Map<string, Usage>()
  private timer?: NodeJS.Timeout
  constructor(private store: ConfigStore, private vault: SecretVault, private changed: () => void) {}
  list(): McpToken[] { return this.store.get().mcp.tokens }
  private require(id: string): McpToken {
    const token = this.list().find((item) => item.id === id)
    if (!token) throw new Error('身份不存在')
    return token
  }
  async create(draft: TokenDraft): Promise<TokenSecret> {
    const value = tokenDraftSchema.parse(draft)
    const id = randomUUID()
    const secret = mint()
    // 先落明文再写配置：配置写失败时回收明文，避免留下无法校验的孤立密文。
    await this.vault.write(id, secret)
    try {
      await this.store.update((config) => {
        if (config.mcp.tokens.length >= MAX_TOKENS) throw new Error(`最多保留 ${MAX_TOKENS} 个身份，请先删除不用的身份`)
        config.mcp.tokens.push({
          id, ...value, enabled: true, prefix: secret.slice(0, 12), hash: fingerprint(secret),
          createdAt: new Date().toISOString(), calls: 0, errors: 0, denied: 0
        })
      })
    } catch (error) { await this.vault.remove(id).catch(() => undefined); throw error }
    this.changed()
    return { id, secret }
  }
  async reveal(id: string): Promise<TokenSecret> {
    this.require(id)
    return { id, secret: await this.vault.read(id) }
  }
  async save(id: string, draft: TokenDraft): Promise<void> {
    const value = tokenDraftSchema.parse(draft)
    this.require(id)
    await this.store.update((config) => { Object.assign(config.mcp.tokens.find((item) => item.id === id)!, value) })
    this.changed()
  }
  async enable(id: string, enabled: boolean): Promise<void> {
    this.require(id)
    await this.store.update((config) => { config.mcp.tokens.find((item) => item.id === id)!.enabled = enabled })
    this.changed()
  }
  // 令牌泄露时换一把新的：保留别名、等级与调用统计，旧令牌立即失效。
  async rotate(id: string): Promise<TokenSecret> {
    this.require(id)
    const previous = await this.vault.read(id).catch(() => undefined)
    const secret = mint()
    await this.vault.write(id, secret)
    try {
      await this.store.update((config) => {
        const token = config.mcp.tokens.find((item) => item.id === id)!
        token.prefix = secret.slice(0, 12); token.hash = fingerprint(secret)
      })
    } catch (error) {
      if (previous) await this.vault.write(id, previous).catch(() => undefined)
      throw error
    }
    this.changed()
    return { id, secret }
  }
  async remove(id: string): Promise<void> {
    this.require(id)
    this.pending.delete(id)
    await this.store.update((config) => { config.mcp.tokens = config.mcp.tokens.filter((item) => item.id !== id) })
    await this.vault.remove(id).catch(() => undefined)
    this.changed()
  }
  // 只比较摘要，避免用令牌长度或前缀差异泄露信息。
  verify(presented: string): McpToken | undefined {
    const digest = createHash('sha256').update(presented).digest()
    let matched: McpToken | undefined
    for (const token of this.list()) {
      const stored = Buffer.from(token.hash, 'hex')
      if (stored.length === digest.length && timingSafeEqual(stored, digest)) matched = token
    }
    return matched
  }
  record(id: string, tool: string, outcome: Outcome): void {
    const usage = this.pending.get(id) || { calls: 0, errors: 0, denied: 0, lastUsedAt: '' }
    usage.calls++
    if (outcome === 'error') usage.errors++
    if (outcome === 'denied') usage.denied++
    usage.lastUsedAt = new Date().toISOString()
    usage.lastTool = tool
    this.pending.set(id, usage)
    // 统计写入配置文件，攒一小段时间再落盘，避免高频调用把磁盘写满。
    this.timer ||= setTimeout(() => { this.timer = undefined; void this.flush().catch(() => undefined) }, 2000)
  }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (!this.pending.size) return
    const usages = new Map(this.pending)
    this.pending.clear()
    try {
      await this.store.update((config) => {
        for (const [id, usage] of usages) {
          const token = config.mcp.tokens.find((item) => item.id === id)
          if (!token) continue
          token.calls += usage.calls; token.errors += usage.errors; token.denied += usage.denied
          token.lastUsedAt = usage.lastUsedAt; token.lastTool = usage.lastTool
        }
      })
    } catch (error) {
      for (const [id, usage] of usages) {
        const kept = this.pending.get(id)
        if (kept) { kept.calls += usage.calls; kept.errors += usage.errors; kept.denied += usage.denied } else {
          this.pending.set(id, usage)
        }
      }
      throw error
    }
    this.changed()
  }
}
