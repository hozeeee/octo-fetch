import type { SandboxCommand, SandboxInput, SandboxMessage } from '../../shared/sandbox'
import type { ScriptLog } from '../../shared/scripts'
import type { CaptureClient } from './capture-client'
import { createRequire, isBuiltin, registerHooks } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import { sandboxInputSchema, serializeSandboxOutput } from '../../shared/sandbox'
import { createCaptureClient } from './capture-client'
import { createDataClient } from './data-client'
import { createNotify } from './notify'

const port = process.parentPort
const nativeRequire = createRequire(path.join(process.cwd(), 'sandbox.js'))
const cwdUrl = pathToFileURL(`${process.cwd()}${path.sep}`).href
let input: SandboxInput | undefined
let stopping = false, completed = false, inFlight = false
let result: string | undefined, outputDirty = false
let logs: ScriptLog[] = [], dropped = 0, windowAt = Date.now(), count = 0
let dataSettle: ((reply: import('../../shared/data-store').DataReply) => boolean) | undefined
let captureClient: CaptureClient | undefined
const cleanups: (() => unknown)[] = []
const errorText = (error: unknown) => (error instanceof Error ? error.stack || error.message : String(error)).slice(0, 4000)
const send = (message: SandboxMessage) => port.postMessage(message)
function log(level: ScriptLog['level'], ...args: unknown[]) {
  if (Date.now() - windowAt >= 1000) { windowAt = Date.now(); count = 0 }
  if (++count > 100) { dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1); return }
  const text = args.map((item) => typeof item === 'string' ? item.slice(0, 2000) : inspect(item, { depth: 3, maxArrayLength: 30, maxStringLength: 1000, customInspect: false, getters: false })).join(' ').slice(0, 2000)
  if (logs.length >= 100) { logs.shift(); dropped++ }
  logs.push({ time: new Date().toISOString(), level, text })
}
function payload(includeOnceResult = false) {
  const value = { logs, dropped, result: input?.mode === 'service' || includeOnceResult ? result : undefined }
  logs = []; dropped = 0; outputDirty = false
  return value
}
function output(value: unknown) {
  if (stopping || completed) throw new Error('运行已结束，不能更新输出')
  result = serializeSandboxOutput(value); outputDirty = true
}
function fail(error: unknown) {
  if (!input || completed) return
  completed = true
  captureClient?.close()
  send({ type: 'failed', runId: input.runId, error: errorText(error), ...payload() })
}
async function dispose() {
  if (!input || stopping) return
  stopping = true
  captureClient?.close()
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup() } catch (error) { log('warn', '清理失败', errorText(error)) }
  }
  send({ type: 'disposed', runId: input.runId, ...payload() })
}
function moduleName(specifier: string): string {
  if (typeof specifier !== 'string' || !specifier) throw new Error('模块名称无效')
  return specifier
}
function importSpecifier(specifier: string, parentURL?: string): string {
  moduleName(specifier)
  if (isBuiltin(specifier) || parentURL?.startsWith(cwdUrl)) return specifier
  return pathToFileURL(nativeRequire.resolve(specifier)).href
}
async function execute(data: SandboxInput) {
  input = data
  for (const [name, level] of Object.entries({ log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' } as const)) {
    console[name as 'log'] = (...args: unknown[]) => log(level, ...args)
  }
  captureClient = createCaptureClient((request) => send({ ...request, runId: data.runId }), () => !stopping && !completed)
  const octo = Object.freeze({
    capture: captureClient.capture,
    vars: Object.freeze({ ...data.values }), log: (...args: unknown[]) => log('info', ...args), output,
    sleep: (ms: number) => {
      if (!Number.isFinite(ms) || ms < 0 || ms > 600000) throw new Error('等待时间必须为 0–600000 毫秒')
      return new Promise<void>((resolve) => setTimeout(resolve, ms))
    },
    onDispose: (callback: () => unknown) => {
      if (stopping || completed) throw new Error('运行已结束，不能注册清理函数')
      if (typeof callback !== 'function' || cleanups.length >= 100) throw new Error('清理函数无效或超过 100 个')
      cleanups.push(callback)
    },
    notify: createNotify((message) => send({ ...message, runId: data.runId }), log, () => !stopping && !completed),
    data: (() => { const client = createDataClient((request) => send({ ...request, runId: data.runId }), () => !stopping && !completed); dataSettle = client.settle; return client.data })()
  })
  try {
    // 使用原生异步函数与 Node.js 模块加载器；入口检查不承担权限隔离。
    registerHooks({ resolve: (specifier, context, nextResolve) => nextResolve(importSpecifier(specifier, context.parentURL), context) })
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
    const executeBody = new AsyncFunction('octo', 'require', `"use strict";\n${data.source}\n//# sourceURL=${data.scriptId}.js`)
    const value = await executeBody(octo, (specifier: string) => nativeRequire(moduleName(specifier)))
    if (stopping || completed) return
    if (value !== undefined) output(value)
    if (data.mode === 'once') { completed = true; captureClient.close() }
    send({ type: data.mode === 'once' ? 'done' : 'ready', runId: data.runId, nodeVersion: process.versions.node, ...payload(true) })
  } catch (error) { fail(error) }
}
// 常驻模式显式保持运行；批次需主进程确认后才继续发送，日志和输出缓存均有界。
setInterval(() => {
  if (!input || inFlight || (!logs.length && !dropped && !outputDirty)) return
  inFlight = true
  send({ type: 'batch', runId: input.runId, ...payload() })
}, 100)
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)
port.on('message', ({ data }: { data: SandboxCommand }) => {
  if (data?.type === 'start' && !input) {
    const parsed = sandboxInputSchema.safeParse(data.input)
    if (parsed.success) void execute(parsed.data)
  } else if (input && data?.type !== 'start' && data?.runId === input.runId) {
    if (data.type === 'ack') inFlight = false
    if (data.type === 'stop') void dispose()
    if (data.type === 'dataReply') dataSettle?.(data.reply)
    if (data.type === 'captureReply') captureClient?.settle(data.reply)
  }
})
