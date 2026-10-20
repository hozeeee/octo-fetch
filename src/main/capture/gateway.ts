import type { Socket } from 'node:net'
import type { CaptureSource } from '../../shared/capture'
import { connect, createServer } from 'node:net'

export const normalizeIp = (ip: string) => ip.replace(/^::ffff:/, '')
export class CaptureGateway {
  private server = createServer((socket) => this.accept(socket))
  private sockets = new Set<Socket>()
  port = 0
  constructor(private enginePort: number, readonly source: CaptureSource, private registry: Map<number, CaptureSource>, private allowed?: string[]) {}
  async listen(port: number, lan = false): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => { this.server.off('error', reject); resolve() })
    })
    this.port = (this.server.address() as { port: number }).port
  }
  private accept(client: Socket) {
    const ip = normalizeIp(client.remoteAddress || '')
    if (ip !== '127.0.0.1' && ip !== '::1' && !this.allowed?.includes(ip)) { client.destroy(); return }
    client.pause()
    const upstream = connect({ port: this.enginePort, host: '127.0.0.1' })
    this.sockets.add(client); this.sockets.add(upstream)
    let registered: number | undefined
    upstream.once('connect', () => {
      registered = upstream.localPort!
      this.registry.set(registered, this.source)
      client.pipe(upstream); upstream.pipe(client); client.resume()
    })
    const close = () => {
      if (registered !== undefined) this.registry.delete(registered)
      client.destroy(); upstream.destroy(); this.sockets.delete(client); this.sockets.delete(upstream)
    }
    client.once('error', close); upstream.once('error', close)
    client.once('close', close); upstream.once('close', close)
  }
  async close() {
    for (const socket of this.sockets) socket.destroy()
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}
