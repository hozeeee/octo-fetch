import type { Page } from 'puppeteer-core'
import type { Hook, InjectionCommand, InjectionMessage, InjectionWorkerInput } from '../../shared/injections'
import type { ScriptLog } from '../../shared/scripts'
import type { CaptureClient } from './capture-client'
import type { DataClient } from './data-client'
import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import { constants, createContext, Script } from 'node:vm'
import { parentPort, workerData } from 'node:worker_threads'
import puppeteer from 'puppeteer-core'
import { createCaptureClient } from './capture-client'
import { createDataClient } from './data-client'
import { createScriptModuleLoader } from './module-loader'
import { createNotify } from './notify'
import { scriptBody } from './store'

const input = workerData as InjectionWorkerInput
const send = (message: InjectionMessage) => parentPort?.postMessage(message)
type Scope = { scriptId: string; tabId: string; disposed: boolean; cleanups: (() => unknown)[]; dataClient?: DataClient; captureClient?: CaptureClient }
const scopes = new Map<string, Scope>()
const callbacks = new Map<string, { scope: Scope; callback: (value: unknown) => unknown }>()
const pages = new Map<string, Page>()
const disabled = new Set<string>()
let navigationTimeout = (input.connectionOptions?.navigationTimeout ?? 30) * 1000
let logWindow = Date.now(), logCount = 0
const heartbeat = setInterval(send, 1000, { type: 'heartbeat' })
const connection = puppeteer.connect({ browserWSEndpoint: input.endpoint, defaultViewport: null, protocolTimeout: 10000, slowMo: input.connectionOptions?.slowMo, acceptInsecureCerts: input.connectionOptions?.acceptInsecureCerts })
// 提前处理连接失败，具体错误仍经每条 RPC 返回。
void connection.catch(() => undefined)

function log(scope: Scope, level: ScriptLog['level'], args: unknown[]) {
  if (Date.now() - logWindow > 1000) { logWindow = Date.now(); logCount = 0 }
  if (logCount++ >= 100) return
  send({ type: 'log', scriptId: scope.scriptId, log: { time: new Date().toISOString(), level, tabId: scope.tabId, text: args.map((value) => typeof value === 'string' ? value : inspect(value, { depth: 3, maxStringLength: 1500, customInspect: false, getters: false })).join(' ').slice(0, 2000) } })
}
async function dispose(scope: Scope) {
  if (scope.disposed) return
  scope.disposed = true
  scope.captureClient?.close()
  scope.dataClient?.rejectAll('注入已停止，数据请求未完成')
  for (const [id, entry] of callbacks) {
    if (entry.scope === scope) { callbacks.delete(id); send({ type: 'unhook', id }) }
  }
  for (const cleanup of scope.cleanups.reverse()) {
    try { await cleanup() } catch (error) { log(scope, 'warn', ['清理失败', String(error)]) }
  }
  scopes.delete(`${scope.tabId}:${scope.scriptId}`)
}
function scopedPage(page: Page, scope: Scope): Page {
  const listeners: { event: Parameters<Page['on']>[0]; listener: (...args: unknown[]) => void; guarded: (...args: unknown[]) => void }[] = []
  const proxy = new Proxy(page, { get(target, property) {
    if (property === 'setRequestInterception') return () => { throw new Error('请使用 octo.interceptRequest / interceptResponse，不能混用原生请求拦截') }
    if (property === 'on' || property === 'once') {
      return (event: Parameters<Page['on']>[0], listener: (...args: unknown[]) => void) => {
        if (scope.disposed) throw new Error('注入已停止')
        const guarded = (...args: unknown[]) => { if (!scope.disposed) listener(...args) }
        listeners.push({ event, listener, guarded })
        target[property](event, guarded)
        scope.cleanups.push(() => target.off(event, guarded))
        return proxy
      }
    }
    if (property === 'off') {
      return (event: Parameters<Page['on']>[0], listener: (...args: unknown[]) => void) => {
        for (let i = listeners.length - 1; i >= 0; i--) {
          const entry = listeners[i]
          if (entry.event === event && entry.listener === listener) { target.off(event, entry.guarded); listeners.splice(i, 1) }
        }
        return proxy
      }
    }
    if (property === 'evaluateOnNewDocument') {
      return async (...args: Parameters<Page['evaluateOnNewDocument']>) => {
        const result = await target.evaluateOnNewDocument(...args)
        if (scope.disposed) await target.removeScriptToEvaluateOnNewDocument(result.identifier)
        else scope.cleanups.push(() => target.removeScriptToEvaluateOnNewDocument(result.identifier))
        return result
      }
    }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return proxy
}
async function operation(command: InjectionCommand): Promise<unknown> {
  const browser = await connection
  if (command.type === 'navigationTimeout') {
    for (const page of pages.values()) {
      if (page.getDefaultNavigationTimeout() === navigationTimeout) page.setDefaultNavigationTimeout(command.seconds * 1000)
    }
    navigationTimeout = command.seconds * 1000
    return
  }
  if (command.type === 'invoke') {
    const entry = callbacks.get(command.hookId)
    if (!entry || entry.scope.disposed || disabled.has(entry.scope.scriptId)) return undefined
    return entry.callback(command.payload)
  }
  if (command.type === 'disable') {
    disabled.add(command.scriptId)
    await Promise.all([...scopes.values()].filter((scope) => scope.scriptId === command.scriptId).map(dispose))
    return
  }
  if (command.type === 'dispose') {
    await Promise.all([...scopes.values()].filter((scope) => scope.tabId === command.tabId).map(dispose))
    pages.delete(command.tabId)
    return
  }
  if (command.type === 'shutdown') {
    await Promise.all([...scopes.values()].map(dispose))
    await browser.disconnect()
    clearInterval(heartbeat)
    return
  }
  if (command.type === 'install') {
    if (disabled.has(command.scriptId) || scopes.has(`${command.tabId}:${command.scriptId}`)) return
    let page = pages.get(command.tabId)
    if (!page) {
      for (const candidate of await browser.pages()) {
        const session = await candidate.createCDPSession()
        try {
          if ((await session.send('Target.getTargetInfo')).targetInfo.targetId === command.targetId) { page = candidate; break }
        } finally { await session.detach() }
      }
    }
    if (!page || page.isClosed()) throw new Error('注入标签已关闭')
    if (!pages.has(command.tabId)) page.setDefaultNavigationTimeout(navigationTimeout)
    pages.set(command.tabId, page)
    const entry = input.scripts.find((entry) => entry.script.id === command.scriptId)
    if (!entry) throw new Error('注入快照中没有此脚本')
    const scope: Scope = { scriptId: entry.script.id, tabId: command.tabId, disposed: false, cleanups: [] }
    const modules = createScriptModuleLoader(entry.moduleRoot)
    scope.dataClient = createDataClient((request) => send({ ...request, scriptId: scope.scriptId, tabId: scope.tabId }), () => !scope.disposed && !disabled.has(scope.scriptId))
    scope.captureClient = createCaptureClient((request) => send({ ...request, scriptId: scope.scriptId, tabId: scope.tabId }), () => !scope.disposed && !disabled.has(scope.scriptId))
    scopes.set(`${command.tabId}:${command.scriptId}`, scope)
    const register = (stage: Hook['stage']) => (options: { urlPattern: string }, callback: (value: unknown) => unknown) => {
      if (scope.disposed) throw new Error('注入已停止')
      if (!options || typeof options.urlPattern !== 'string' || !options.urlPattern || options.urlPattern.length > 4096 || typeof callback !== 'function') throw new Error('拦截器需要 urlPattern 和处理函数')
      if ([...callbacks.values()].filter((entry) => entry.scope === scope).length >= 100) throw new Error('每个注入在每个标签最多注册 100 个拦截器')
      const id = randomUUID()
      callbacks.set(id, { scope, callback })
      send({ type: 'hook', hook: { id, scriptId: scope.scriptId, tabId: scope.tabId, stage, urlPattern: options.urlPattern } })
      return () => { callbacks.delete(id); send({ type: 'unhook', id }) }
    }
    const sleep = (ms: number) => new Promise<void>((resolve, reject) => {
      if (!Number.isFinite(ms) || ms < 0 || ms > 600000) throw new Error('等待时间必须为 0–600000 毫秒')
      if (scope.disposed) throw new Error('注入已停止')
      const cleanup = () => { clearTimeout(timer); reject(new Error('注入已停止')) }
      const timer = setTimeout(() => { scope.cleanups.splice(scope.cleanups.indexOf(cleanup), 1); resolve() }, ms)
      scope.cleanups.push(cleanup)
    })
    const context = createContext({
      page: scopedPage(page, scope), browser, require: modules.require, process, Buffer, fetch, URL, URLSearchParams,
      setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, queueMicrotask,
      octo: Object.freeze({
        site: Object.freeze({ ...input.site, tabId: command.tabId, currentUrl: command.currentUrl }), vars: Object.freeze(entry.values), sleep,
        log: (...args: unknown[]) => log(scope, 'info', args),
        notify: createNotify((message) => send({ ...message, scriptId: scope.scriptId, tabId: scope.tabId }), (level, text) => log(scope, level, [text]), () => !scope.disposed && !disabled.has(scope.scriptId)),
        data: scope.dataClient.data, capture: scope.captureClient.capture,
        interceptRequest: register('request'), interceptResponse: register('response'),
        onDispose: (fn: () => unknown) => { if (typeof fn !== 'function' || scope.disposed) throw new Error('清理函数无效或注入已停止'); scope.cleanups.push(fn) }
      }),
      console: Object.freeze(Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((level) => [level, (...args: unknown[]) => log(scope, level === 'log' ? 'info' : level as ScriptLog['level'], args)])))
    }, { codeGeneration: { strings: false, wasm: false } })
    await new Script(scriptBody(entry.script.draft.source), { filename: modules.filename, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }).runInContext(context, { timeout: entry.script.draft.timeout * 1000 })
    send({ type: 'initialized', scriptId: scope.scriptId, tabId: scope.tabId })
  }
}
parentPort?.on('message', (command: InjectionCommand) => {
  if (command.type === 'captureReply') {
    for (const scope of scopes.values()) {
      if (scope.captureClient?.settle(command.reply)) break
    } return
  }
  if (command.type === 'dataReply') {
    for (const scope of scopes.values()) {
      if (scope.dataClient?.settle(command.reply)) break
    } return
  }
  void operation(command).then((value) => {
    try { send({ type: 'reply', id: command.id, value }) } catch { send({ type: 'reply', id: command.id, error: '拦截结果必须可序列化' }) }
  }, (error) => send({ type: 'reply', id: command.id, error: String(error).slice(0, 4000) }))
})
process.on('unhandledRejection', (error) => { throw error })
