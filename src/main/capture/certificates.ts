import { X509Certificate } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'

// 固定版本 Whistle 的独立 CA 目录；不读取用户全局证书或系统钥匙串。
export function certificateDirectory(directory: string) { return path.join(directory, '.whistle', 'certs') }
export async function readCertificate(directory: string): Promise<string> {
  for (const name of ['root_new.crt', 'root.crt']) {
    try {
      const pem = await readFile(path.join(certificateDirectory(directory), name), 'utf8')
      const cert = new X509Certificate(pem)
      if (!cert.ca) throw new Error('抓包 CA 无效')
      return cert.toString()
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  throw new Error('尚未生成抓包 CA，请先启动一次抓包代理')
}
export async function resetCertificate(directory: string): Promise<void> {
  await rm(certificateDirectory(directory), { recursive: true, force: true })
}
