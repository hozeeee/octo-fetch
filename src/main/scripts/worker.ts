import type { Browser } from 'puppeteer-core'
import type { CaptureReply } from '../../shared/capture'
import type { DataReply } from '../../shared/data-store'
import type { ScriptLog } from '../../shared/scripts'
import type { WorkerInput, WorkerMessage } from './runner'
import { inspect } from 'node:util'
import { constants, createContext, Script } from 'node:vm'
import { parentPort, workerData } from 'node:worker_threads'
import puppeteer from 'puppeteer-core'
import { matchesUrl, MAX_LOGS, MAX_OUTPUT } from '../../shared/scripts'
import { createCaptureClient } from './capture-client'
import { createDataClient } from './data-client'
import { createScriptModuleLoader } from './module-loader'
import { createNotify } from './notify'
import { scriptBody } from './store'

const input = workerData as WorkerInput
const modules = createScriptModuleLoader(input.moduleRoot)
const send = (message: WorkerMessage) => parentPort!.postMessage(message)
// 行动脚本经 data client 读写数据仓库，应答由主进程原路回投到本 worker。
const dataClient = createDataClient((request) => send(request))
const captureClient = createCaptureClient(send)
parentPort!.on('message', (reply: DataReply | CaptureReply | { type: 'captureClose' }) => {
  if (reply?.type === 'data-reply') dataClient.settle(reply)
  if (reply?.type === 'captureReply') captureClient.settle(reply)
  if (reply?.type === 'captureClose') captureClient.close()
})
let logCount = 0
let dropped = 0
let result: string | undefined
function log(level: ScriptLog['level'], ...args: unknown[]) {
  // 限制跨线程消息数量，避免高频 console 输出淹没主进程消息队列。
  if (logCount++ >= MAX_LOGS - 2) { dropped++; return }
  const text = args.map((value) => typeof value === 'string' ? value.slice(0, 2000) : inspect(value, { depth: 3, maxArrayLength: 30, maxStringLength: 1000, customInspect: false, getters: false })).join(' ').slice(0, 2000)
  send({ type: 'log', log: { time: new Date().toISOString(), level, text } })
}
function output(value: unknown) {
  const serialized = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' || (typeof item === 'number' && !Number.isFinite(item))) throw new Error('结果必须可以无损转换为 JSON')
    return item
  })
  if (serialized === undefined) throw new Error('结果必须是 JSON 值')
  if (serialized.length > MAX_OUTPUT) throw new Error('输出结果超过 64K 字符，请减少数据或分批运行')
  result = serialized
}
async function execute() {
  let browser: Browser | undefined
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: input.endpoint, defaultViewport: null, protocolTimeout: Math.min(30000, input.timeout * 1000), slowMo: input.connectionOptions?.slowMo, acceptInsecureCerts: input.connectionOptions?.acceptInsecureCerts })
    let page
    for (const candidate of await browser.pages()) {
      const session = await candidate.createCDPSession()
      try {
        const info = await session.send('Target.getTargetInfo')
        if (info.targetInfo.targetId === input.targetId) { page = candidate; break }
      } finally { await session.detach() }
    }
    if (!page || page.isClosed()) throw new Error('执行标签已关闭')
    if (!matchesUrl(input.match, page.url())) throw new Error('当前标签已跳转到不适用的域名')
    page.setDefaultTimeout(Math.min(30000, input.timeout * 1000))
    page.setDefaultNavigationTimeout(Math.min((input.connectionOptions?.navigationTimeout ?? 30) * 1000, input.timeout * 1000))
    const sleep = (milliseconds: number) => new Promise<void>((resolve) => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 600000) throw new Error('等待时间必须为 0–600000 毫秒')
      setTimeout(resolve, milliseconds)
    })
    const context = createContext({
      page, browser, require: modules.require, process, Buffer, fetch, URL, URLSearchParams,
      setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, queueMicrotask,
      octo: Object.freeze({ site: Object.freeze({ ...input.site, currentUrl: page.url() }), vars: Object.freeze(input.values), log: (...args: unknown[]) => log('info', ...args), sleep, output, notify: createNotify(send, log), data: dataClient.data, capture: captureClient.capture }),
      console: Object.freeze({ log: (...args: unknown[]) => log('info', ...args), info: (...args: unknown[]) => log('info', ...args), warn: (...args: unknown[]) => log('warn', ...args), error: (...args: unknown[]) => log('error', ...args), debug: (...args: unknown[]) => log('debug', ...args) })
    }, { codeGeneration: { strings: false, wasm: false } })
    // 完整 Node 模式：脚本及依赖拥有 Worker 进程级本机权限，生命周期仍由主进程强制终止。
    const value = await new Script(scriptBody(input.source), { filename: modules.filename, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }).runInContext(context)
    if (value !== undefined) output(value)
    send({ type: 'done', result, dropped })
  } catch (error) {
    send({ type: 'failed', error: (error && typeof error === 'object' && 'stack' in error ? String(error.stack) : String(error)).slice(0, 4000), dropped })
  } finally {
    captureClient.close()
    // 仅断开执行连接，绝不关闭共享登录会话。
    await browser?.disconnect().catch(() => undefined)
    parentPort?.close()
  }
}
void execute()
