import type { ElectronApplication, Page } from '@playwright/test'
import type { Command, DesktopAPI, Site, Snapshot } from '../../src/shared/model'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { _electron, expect } from '@playwright/test'

declare global { interface Window { octo: DesktopAPI } }
export async function launchDesktop(directory?: string) {
  const dataDir = directory || path.join(process.cwd(), '.test-data', randomUUID())
  await mkdir(dataDir, { recursive: true })
  const executablePath = process.env.OCTO_TEST_EXECUTABLE
  const application = await _electron.launch({ executablePath, args: executablePath ? [`--user-data-dir=${dataDir}`] : [process.cwd()], env: { ...process.env, OCTO_DATA_DIR: dataDir }, timeout: executablePath ? 90000 : 30000 })
  const actual = await application.evaluate(({ app }) => ({ dataDir: app.getPath('userData'), packaged: app.isPackaged, appPath: app.getAppPath(), arch: process.arch }))
  if (path.resolve(actual.dataDir) !== path.resolve(dataDir)) { await application.close(); throw new Error('测试应用未使用独立数据目录，已停止测试') }
  if (executablePath) {
    expect(actual.packaged).toBe(true)
    expect(actual.appPath).toMatch(/app\.asar$/)
    if (process.env.OCTO_TEST_ARCH) expect(actual.arch).toBe(process.env.OCTO_TEST_ARCH)
  }
  const page = await application.firstWindow()
  await page.waitForFunction(() => Boolean(window.octo))
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible()
  return { application, page, dataDir }
}
export async function state(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => { const reply = await window.octo.snapshot(); if (!reply.ok) throw new Error(reply.error); return reply.data })
}
export async function command(page: Page, value: Command): Promise<void> {
  const reply = await page.evaluate((value) => window.octo.command(value), value)
  if (!reply.ok) throw new Error(reply.error)
}
export async function addSite(page: Page, name: string, url: string): Promise<Site> {
  await command(page, { type: 'site.save', draft: { name, url } })
  return (await state(page)).config.sites.find((site) => site.name === name)!
}
export async function stopAll(application: ElectronApplication, page: Page) {
  try {
    for (const site of (await state(page)).config.sites) await command(page, { type: 'browser.stop', siteId: site.id })
  } finally { await application.close() }
}
export async function remoteClick(page: Page, x: number, y: number) {
  const canvas = page.locator('.focus-canvas canvas')
  const siteId = await canvas.getAttribute('data-site-id')
  const runtime = (await state(page)).runtimes.find((item) => item.siteId === siteId)!
  await expect(canvas).toHaveAttribute('data-tab-id', runtime.activeTabId!)
  await expect(canvas).toHaveAttribute('aria-busy', 'false')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('找不到画面')
  const scale = Math.min(box.width / 1280, box.height / 800)
  await page.mouse.click(box.x + (box.width - 1280 * scale) / 2 + x * scale, box.y + (box.height - 800 * scale) / 2 + y * scale)
}
export type Report = { client: string; text: string; cookie: string; local: string | null; indexed: string | null; callback: boolean; dialog: boolean; scroll: number; drag: number; frameText?: string }
export async function testSite() {
  const reports = new Map<string, Report>()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    if (url.pathname === '/report') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      try { const body = JSON.parse(Buffer.concat(chunks).toString()) as Report; reports.set(body.client, body) } catch { /* 测试站忽略无效上报。 */ }
      res.writeHead(204); res.end(); return
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (url.pathname === '/popup') {
      res.end('<html><head><title>授权窗口</title></head><body><button style="position:absolute;left:40px;top:200px;width:220px;height:44px" onclick="opener.postMessage(\'authorized\',location.origin);window.close()">完成授权并关闭</button></body></html>'); return
    }
    if (url.pathname === '/frame') {
      res.end('<input style="margin:20px;width:240px;height:40px" oninput="parent.postMessage({frameText:this.value},\'*\')" placeholder="跨域 iframe 输入" />'); return
    }
    const client = JSON.stringify(url.searchParams.get('client') || 'a')
    res.end(`<!doctype html><html lang="zh-CN"><head><title>会话验证站</title><style>
      *{box-sizing:border-box}body{margin:0;padding:40px;background:#f3f7f5;color:#214f42;font-family:system-ui;height:1600px}h1{font-size:32px;margin:10px 0}p{color:#6f8a7c}input,button{font:16px system-ui;border:1px solid #bad3c7;border-radius:8px}input{position:absolute;left:40px;top:160px;width:360px;height:44px;padding:12px}button{position:absolute;top:240px;height:44px;background:#216b55;color:white;padding:0 18px}#persist{left:40px}#popup{left:220px}#alert{left:390px}#password{top:320px}#editable{position:absolute;left:40px;top:400px;width:360px;height:80px;border:1px solid #bad3c7;padding:12px;background:white}#drag{position:absolute;top:550px;left:40px;width:100px;height:60px;background:#c5e5d5;border-radius:10px;display:grid;place-items:center;touch-action:none}#pulse{position:absolute;top:38px;right:40px;width:60px;height:60px;border-radius:50%;background:#77b495}iframe{position:absolute;left:600px;top:160px;width:430px;height:150px;border:1px solid #bad3c7;border-radius:8px}
      </style></head><body><h1>会话验证站</h1><p>本地测试页面 · 实时画面、输入与登录态验证</p><input id="text" placeholder="点击这里，输入中文" /><button id="persist">保存测试登录态</button><button id="popup">打开授权窗口</button><button id="alert">测试对话框</button><input id="password" type="password" value="test-password" /><div id="editable" contenteditable="true">可编辑内容</div><div id="drag">拖动滑块</div><div id="pulse"></div><iframe src="http://localhost:${(server.address() as { port: number }).port}/frame"></iframe><script>
      const client=${client};let indexed=null,callback=false,answered=false,drag=0,frameText='';
      const database=indexedDB.open('fixture',1);database.onupgradeneeded=()=>database.result.createObjectStore('state');database.onsuccess=()=>{const request=database.result.transaction('state').objectStore('state').get('login');request.onsuccess=()=>indexed=request.result||null};
      document.getElementById('persist').onclick=()=>{document.cookie='login='+client+'; Max-Age=86400; Path=/';localStorage.setItem('login',client);const tx=database.result.transaction('state','readwrite');tx.objectStore('state').put(client,'login');tx.oncomplete=()=>indexed=client};
      document.getElementById('popup').onclick=()=>window.open('/popup','auth');document.getElementById('alert').onclick=()=>{answered=confirm('测试对话框')};
      window.addEventListener('message',event=>{if(event.data==='authorized')callback=true;if(event.data?.frameText)frameText=event.data.frameText});
      const slider=document.getElementById('drag');slider.onpointerdown=e=>slider.setPointerCapture(e.pointerId);slider.onpointermove=e=>{if(e.buttons){drag=e.clientX;slider.style.left=(e.clientX-50)+'px'}};
      setInterval(()=>{document.getElementById('pulse').style.opacity=String(.45+Math.sin(Date.now()/500)*.35);fetch('/report',{method:'POST',body:JSON.stringify({client,text:document.getElementById('text').value,cookie:document.cookie,local:localStorage.getItem('login'),indexed,callback,dialog:answered,scroll:scrollY,drag,frameText})}).catch(()=>{})},200);
      </script></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, reports, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }) }
}
