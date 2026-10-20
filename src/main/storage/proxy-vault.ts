import type { ProxyCredentials } from '../../shared/browser-options'
import type { Encryptor } from './store'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { proxyCredentialsSchema } from '../../shared/browser-options'
import { configSchema, idSchema } from '../../shared/model'
import { atomicWrite, SerialQueue } from './store'

export class ProxyVault {
  private queue = new SerialQueue()
  constructor(private directory: string, private encryptor: Encryptor, private scope: 'sites' | 'capture' = 'sites') {}
  private get namespace() { return this.scope === 'sites' ? 'proxy-credentials' : 'capture-proxy-credentials' }
  private file(id: string) { return path.join(this.directory, this.namespace, `${idSchema.parse(id)}.enc`) }
  async create(credentials: ProxyCredentials): Promise<string> {
    const id = randomUUID()
    try { await atomicWrite(this.file(id), await this.encryptor.encrypt(JSON.stringify(proxyCredentialsSchema.parse(credentials)))) } catch { throw new Error('代理凭据加密保存失败，请检查钥匙串授权及磁盘空间') }
    return id
  }
  async read(id: string): Promise<ProxyCredentials> {
    try { return proxyCredentialsSchema.parse(JSON.parse(await this.encryptor.decrypt(await readFile(this.file(id))))) } catch { throw new Error('代理凭据读取或解密失败，请检查钥匙串授权，或重新填写代理认证') }
  }
  async remove(id: string) { await rm(this.file(id), { force: true }) }
  async collect(references: Set<string>): Promise<void> {
    await this.queue.run(async () => {
      // 备份可恢复旧配置，因此不能过早清理其凭据。无法读取备份时保守保留。
      try {
        const backup = configSchema.parse(JSON.parse(await readFile(path.join(this.directory, 'config.json.bak'), 'utf8')))
        if (this.scope === 'capture') { if (backup.capture.credentialId) references.add(backup.capture.credentialId) } else {
          for (const site of backup.sites) {
            if (site.proxyCredentialId) references.add(site.proxyCredentialId)
          }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return }
      let files: string[]
      try { files = await readdir(path.join(this.directory, this.namespace)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      for (const file of files) {
        const id = file.replace(/\.enc$/, '')
        if (file.endsWith('.enc') && idSchema.safeParse(id).success && !references.has(id)) await this.remove(id)
      }
    })
  }
}
