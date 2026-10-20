import type { BrowserOptions, ProxyCredentials } from '../../shared/browser-options'
import { Server } from 'proxy-chain'

export function assertCaptureDestination(host: string, port: number, blocked: Set<number>) {
  const hostname = host.toLowerCase().replace(/\.$/, '')
  if (blocked.has(port) || /(?:^|\.)(?:whistlejs\.com|wproxy\.org)$/.test(hostname)) throw new Error('禁止访问抓包内部服务或代理环路')
}
export async function createUpstream(upstream: BrowserOptions['proxy'], credentials: ProxyCredentials | undefined, blocked: Set<number>) {
  let url: URL | undefined
  if (upstream) {
    url = new URL(upstream.server)
    assertCaptureDestination(url.hostname, Number(url.port || (url.protocol === 'https:' ? 443 : url.protocol === 'socks5:' ? 1080 : 80)), blocked)
    // Chromium 的 SOCKS5 由代理解析目标域名；中继保持相同语义，不在本机提前解析。
    if (url.protocol === 'socks5:') url.protocol = 'socks5h:'
    if (credentials) { url.username = credentials.username; url.password = credentials.password }
  }
  const server = new Server({
    host: '127.0.0.1', port: 0,
    prepareRequestFunction: ({ hostname, port }) => {
      assertCaptureDestination(hostname, port, blocked)
      return { upstreamProxyUrl: url?.href, ignoreUpstreamProxyCertificate: false }
    }
  })
  // 不记录该依赖的 requestFailed 详情，其中可能包含上游 URL 凭据。
  server.on('error', () => undefined)
  await server.listen()
  blocked.add(server.port)
  return server
}
