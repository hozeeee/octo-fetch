import type { Socket } from 'node:net'
import type { Browser } from 'puppeteer-core'
import type { CaptureLease, CapturePage, CaptureReady } from '../../src/shared/capture'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { createSecureServer } from 'node:http2'
import { connect } from 'node:net'
import path from 'node:path'
import { connect as connectTls } from 'node:tls'
import { expect, test } from '@playwright/test'
import puppeteer from 'puppeteer-core'
import { captureSettingsSchema } from '../../src/shared/capture'
import { launchDesktop } from './helpers'

function fetchProxy(port: number, url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: url, headers: { host: new URL(url, `http://127.0.0.1:${port}`).host, ...headers } }, (res) => {
      let body = ''; res.on('data', (chunk) => { body += chunk }); res.on('end', () => resolve({ status: res.statusCode!, body }))
    })
    req.setTimeout(8000, () => req.destroy(new Error('代理请求超时'))); req.on('error', reject); req.end()
  })
}
async function tlsFixture(directory: string, name: string) {
  const keyFile = path.join(directory, `${name}.key`), certFile = path.join(directory, `${name}.crt`)
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=same.example', '-addext', 'subjectAltName=DNS:same.example,DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
  const tls = { key: await readFile(keyFile), cert: await readFile(certFile) }
  const received: { url: string; version: string; headers: object }[] = []
  const server = createSecureServer({ ...tls, allowHTTP1: true }, (req, res) => {
    received.push({ url: req.url!, version: req.httpVersion, headers: req.headers })
    res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(name)
  })
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    const payload = Buffer.from(name)
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
    socket.on('error', () => socket.destroy()); socket.on('data', () => socket.end())
  })
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { certFile, received, port: (server.address() as { port: number }).port, close: () => { for (const socket of sockets) socket.destroy(); server.close() } }
}
function tlsProxy(port: number, ca: string, pathname: string, headers = '', host = 'same.example') {
  return new Promise<string>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method: 'CONNECT', path: 'same.example:443', headers: { host: 'same.example:443' } })
    req.on('error', reject)
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`CONNECT ${res.statusCode}`)); return }
      const tls = connectTls({ socket, servername: 'same.example', ca, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] }, () => {
        tls.write(`GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${headers}\r\n`)
      })
      let result = ''
      tls.on('data', (chunk) => { result += chunk }); tls.on('end', () => { tls.destroy(); resolve(result) })
      tls.on('error', reject); tls.setTimeout(10000, () => tls.destroy(new Error('HTTPS 请求超时')))
    })
    req.setTimeout(10000, () => req.destroy(new Error('CONNECT 超时'))); req.end()
  })
}
test('Whistle 真实子进程、HTTP/HTTPS 双出口、严格 TLS 与 CA 限定信任', async () => {
  const desktop = await launchDesktop()
  const runtime = await desktop.application.evaluate(({ app }) => ({ appPath: app.getAppPath(), resources: process.resourcesPath, packaged: app.isPackaged, arch: process.arch }))
  const assets = await desktop.application.evaluate(async ({ app }) => {
    const fs = process.getBuiltinModule('node:fs').promises
    const path = process.getBuiltinModule('node:path')
    const root = path.join(app.getAppPath(), 'node_modules', 'whistle')
    return {
      version: JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version,
      license: await fs.readFile(path.join(root, 'LICENSE'), 'utf8'),
      uiBytes: (await fs.stat(path.join(root, 'biz/webui/htdocs/js/index.js'))).size
    }
  })
  expect(assets.version).toBe('2.10.10')
  expect(assets.license).toContain('MIT')
  expect(assets.uiBytes).toBeGreaterThan(100000)
  const trusted = await tlsFixture(desktop.dataDir, '可信目标')
  const untrusted = await tlsFixture(desktop.dataDir, '不可信目标')
  let browser: Browser | undefined
  const tunnels = new Set<Socket>()
  const servers = ['出口一', '出口二'].map((name) => createServer((_req, res) => { res.setHeader('Content-Type', 'text/plain'); res.end(name) }))
  for (const [index, server] of servers.entries()) {
    server.on('connect', (_req, socket, head) => {
      const upstream = connect(index === 0 ? trusted.port : untrusted.port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head)
        socket.pipe(upstream); upstream.pipe(socket)
      })
      tunnels.add(upstream); upstream.on('close', () => { tunnels.delete(upstream); socket.destroy() })
      socket.on('close', () => upstream.destroy()); socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  }
  const reservation = createServer()
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  try {
    await desktop.application.evaluate(async ({ utilityProcess, app }, input) => {
      const child = utilityProcess.fork(input.entry, [], { stdio: 'pipe', env: { PATH: '', HOME: app.getPath('userData'), NODE_EXTRA_CA_CERTS: input.ca } })
      const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
      const api = { child, errors: '', rpc: (command: { id: string }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(command.id); reject(new Error('抓包测试 RPC 超时')) }, 15000)
        pending.set(command.id, { resolve: (value) => { clearTimeout(timer); resolve(value) }, reject: (error) => { clearTimeout(timer); reject(error) } }); child.postMessage(command)
      }) }
      child.stderr?.on('data', (data) => { api.errors += String(data) })
      child.on('message', (data) => { if (data.type !== 'reply') return; const p = pending.get(data.id); pending.delete(data.id); if (data.ok) p?.resolve(data.value); else p?.reject(new Error(data.error)) })
      child.on('exit', () => { for (const p of pending.values()) p.reject(new Error(api.errors || '抓包进程退出')) })
      Object.assign(globalThis, { captureProbe: api })
    }, { entry: path.join(runtime.appPath, 'out/main/capture-process.js'), ca: trusted.certFile })
    const rpc = <T>(command: object) => desktop.application.evaluate(async (_, command) => {
      const api = (globalThis as unknown as { captureProbe: { rpc(command: object): Promise<unknown> } }).captureProbe
      return api.rpc(command)
    }, { ...command, id: randomUUID() }) as Promise<T>
    const ready = await rpc<CaptureReady>({ op: 'start', directory: path.join(desktop.dataDir, 'capture'), generation: randomUUID(), settings: captureSettingsSchema.parse({ port }) })
    expect(ready.spki).toMatch(/^[\w+/]+=*$/)
    const source1 = { id: randomUUID(), siteId: randomUUID(), generation: randomUUID(), name: '网站一' }
    const source2 = { id: randomUUID(), siteId: randomUUID(), generation: randomUUID(), name: '网站二' }
    const acquire = (source: typeof source1, index: number) => rpc<CaptureLease>({ op: 'acquire', source, upstream: { server: `http://127.0.0.1:${(servers[index].address() as { port: number }).port}`, bypass: [] } })
    const [one, two] = [await acquire(source1, 0), await acquire(source2, 1)]
    expect(await fetchProxy(one.port, 'http://same.example/test')).toEqual({ status: 200, body: '出口一' })
    expect(await fetchProxy(two.port, 'http://same.example/test')).toEqual({ status: 200, body: '出口二' })
    const records = await rpc<CapturePage>({ op: 'query', query: {} })
    expect(records.items.map((item) => item.source.siteId)).toEqual([source1.siteId, source2.siteId])
    for (const url of [
      `http://127.0.0.1:${ready.uiPort}/cgi-bin/init`,
      `http://localhost:${ready.uiPort}/cgi-bin/init`,
      `http://[::1]:${ready.uiPort}/cgi-bin/init`,
      `http://2130706433:${ready.uiPort}/cgi-bin/init`,
      `http://same.example:${one.port}/`,
      'http://local.whistlejs.com/cgi-bin/init',
      'http://local.wproxy.org/cgi-bin/init'
    ]) {
      expect((await fetchProxy(port, url)).status, url).toBe(403)
      expect((await fetchProxy(port, url, { 'Connection': 'Upgrade', 'Upgrade': 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'X-Whistle-Client-Port': '1' })).status, `Upgrade ${url}`).toBe(403)
    }
    for (const target of [`localhost:${ready.uiPort}`, `127.0.0.1:${ready.uiPort}`, `[::1]:${ready.uiPort}`, `2130706433:${ready.uiPort}`, `same.example:${one.port}`, 'local.whistlejs.com:443', 'local.wproxy.org:443']) {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, method: 'CONNECT', path: target })
        req.on('connect', (res, socket) => {
          if (res.statusCode !== 200) { socket.destroy(); resolve({ status: res.statusCode!, body: '' }); return }
          let body = ''
          socket.on('data', (chunk) => { body += chunk })
          socket.on('close', () => resolve({ status: res.statusCode!, body }))
          socket.on('error', reject); socket.setTimeout(3000, () => socket.destroy())
          socket.write(`GET /cgi-bin/init HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`)
        })
        req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('内部 CONNECT 超时'))); req.end()
      })
      expect(result, `内部 CONNECT ${target}`).toEqual({ status: 403, body: '' })
    }
    expect((await fetchProxy(ready.uiPort, '/cgi-bin/rootca')).status).toBe(401)
    const ca = await rpc<string>({ op: 'certificate' })
    const tlsResult = await tlsProxy(one.port, ca, '/trusted', 'X-Whistle-Rule-Value: *%20statusCode://201\r\nX-Octo-Capture-Source: forged\r\n')
    expect(tlsResult).toContain('200 OK')
    expect(tlsResult).toContain('可信目标')
    expect(JSON.stringify(trusted.received)).not.toMatch(/x-whistle-|x-octo-capture-/i)
    expect(await tlsProxy(one.port, ca, '/cgi-bin/init', '', `localhost:${ready.uiPort}`)).toContain('403 Forbidden')
    const rejected = await tlsProxy(two.port, ca, '/untrusted')
    expect(rejected).toContain('502')
    expect(untrusted.received).toHaveLength(0)
    const secureRecords = await rpc<CapturePage>({ op: 'query', query: { url: '/trusted' } })
    expect(secureRecords.items.map((item) => item.source.siteId)).toEqual([source1.siteId])
    const secureSource = { id: randomUUID(), siteId: randomUUID(), generation: randomUUID(), name: 'HTTPS 上游' }
    const secure = await rpc<CaptureLease>({ op: 'acquire', source: secureSource, upstream: { server: `https://127.0.0.1:${trusted.port}`, bypass: [] }, credentials: { username: 'fixture', password: 'https-password' } })
    expect(await fetchProxy(secure.port, 'http://same.example/secure-upstream')).toEqual({ status: 200, body: '可信目标' })
    expect(trusted.received.find((item) => item.url.includes('/secure-upstream'))?.headers).toMatchObject({ 'proxy-authorization': `Basic ${Buffer.from('fixture:https-password').toString('base64')}` })
    const unsafe = await rpc<CaptureLease>({ op: 'acquire', source: { ...secureSource, id: randomUUID() }, upstream: { server: `https://127.0.0.1:${untrusted.port}`, bypass: [] } })
    expect((await fetchProxy(unsafe.port, 'http://same.example/unsafe-upstream')).status).toBeGreaterThanOrEqual(500)
    expect(untrusted.received).toHaveLength(0)
    const root = runtime.packaged ? path.join(runtime.resources, 'browser') : path.join(process.cwd(), '.browsers', runtime.arch)
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as { executable: string }
    browser = await puppeteer.launch({ executablePath: path.join(root, manifest.executable), headless: true, acceptInsecureCerts: false, args: [`--proxy-server=http://127.0.0.1:${one.port}`, `--ignore-certificate-errors-spki-list=${ready.spki}`, '--disable-quic'] })
    const page = (await browser.pages())[0]
    expect((await page.goto('https://same.example/chrome', { timeout: 15000 }))?.status()).toBe(200)
    expect(await page.content()).toContain('可信目标')
    expect(trusted.received.find((item) => item.url === '/chrome')?.version).toBe('2.0')
    expect(await page.evaluate(() => new Promise((resolve, reject) => {
      const socket = new WebSocket('wss://same.example/ws')
      const timer = setTimeout(() => { socket.close(); reject(new Error('WebSocket 超时')) }, 10000)
      socket.onmessage = (event) => { clearTimeout(timer); resolve(event.data); socket.close() }
      socket.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket 失败')) }
    }))).toBe('可信目标')
    const wsRecords = await rpc<CapturePage>({ op: 'query', query: { url: '/ws' } })
    expect(wsRecords.items.map((item) => item.source.siteId)).toEqual([source1.siteId])
    await expect(page.goto(`https://127.0.0.1:${untrusted.port}/direct`, { timeout: 15000 })).rejects.toThrow(/CERT_AUTHORITY_INVALID/)
    await browser.close(); browser = undefined
    const isolated = await desktop.application.evaluate(async ({ BrowserWindow, WebContentsView, session }, { ready, directUrl }) => {
      const partition = session.fromPartition(`capture-probe-${Date.now()}`)
      const origin = `http://127.0.0.1:${ready.uiPort}`
      partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      partition.setPermissionCheckHandler(() => false)
      partition.webRequest.onBeforeSendHeaders((details, callback) => {
        if (new URL(details.url).origin === origin) details.requestHeaders.Authorization = `Basic ${Buffer.from(`${ready.username}:${ready.password}`).toString('base64')}`
        callback({ requestHeaders: details.requestHeaders })
      })
      const view = new WebContentsView({ webPreferences: { session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true } })
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      view.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault() })
      const window = BrowserWindow.getAllWindows()[0]
      window.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 1000, height: 600 })
      try {
        await view.webContents.loadURL(origin)
        const access = await view.webContents.executeJavaScript(`({octo:typeof window.octo,require:typeof require,process:typeof process})`)
        const result = await view.webContents.executeJavaScript(`(async()=>{
          const data = await fetch('/cgi-bin/get-data?startTime=0&count=100').then(r=>r.json());
          const originals = Object.values(data.data.data).filter(r=>r.url==='http://same.example/test');
          const compose = async (url, headers) => fetch('/cgi-bin/composer', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url,method:'GET',headers,body:'',needResponse:true,noStore:true})}).then(async r=>({status:r.status,body:await r.text()}));
          const replay = [];
          for (const item of originals) replay.push(await compose(item.url,'Host: same.example\\r\\nX-Whistle-Client-Id: '+item.clientId));
          return {composer:await compose(${JSON.stringify(directUrl)},''), replay, originals:originals.map(item=>item.clientId)};
        })()`)
        return { access, ...result }
      } finally { window.contentView.removeChildView(view); view.webContents.close() }
    }, { ready, directUrl: `http://127.0.0.1:${(servers[0].address() as { port: number }).port}/new` })
    expect(isolated.access).toEqual({ octo: 'undefined', require: 'undefined', process: 'undefined' })
    expect(isolated.composer, '现成工作台 Composer 必须能通过受控出口发送请求').toMatchObject({ status: 200 })
    expect(JSON.parse(isolated.composer.body).res?.statusCode).toBe(200)
    expect(isolated.originals).toEqual(records.items.map((item) => item.id))
    expect(isolated.replay.map((item: { body: string }) => Buffer.from(JSON.parse(item.body).res.base64, 'base64').toString())).toEqual(['出口一', '出口二'])
    await rpc({ op: 'release', sourceId: source1.id })
    const expired = await fetch(`http://127.0.0.1:${ready.uiPort}/cgi-bin/composer`, { method: 'POST', headers: { 'authorization': `Basic ${Buffer.from(`${ready.username}:${ready.password}`).toString('base64')}`, 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://same.example/test', method: 'GET', headers: `X-Whistle-Client-Id: ${records.items[0].id}`, needResponse: true }) })
    expect(expired.status).toBe(409)
    await rpc({ op: 'stop' })
    for (const stoppedPort of [port, ready.uiPort, one.port, two.port, secure.port, unsafe.port]) {
      await expect.poll(() => fetchProxy(stoppedPort, '/').then(() => true, () => false)).toBe(false)
    }
  } finally {
    await browser?.close()
    for (const socket of tunnels) socket.destroy()
    trusted.close(); untrusted.close()
    await desktop.application.evaluate(() => { (globalThis as unknown as { captureProbe?: { child: { kill(): void } } }).captureProbe?.child.kill() }).catch(() => undefined)
    for (const server of servers) { server.closeAllConnections(); server.close() }
    await desktop.application.close()
  }
})
