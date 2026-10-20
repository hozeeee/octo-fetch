import type { BrowserConnectionOptions } from './browser-options'
import type { CaptureReply, CaptureRequest } from './capture'
import type { DataOp, DataReply } from './data-store'
import type { NotifyWorkerMessage } from './notifications'
import type { SavedScript, ScriptLog } from './scripts'
import { z } from 'zod'
import { MAX_SCRIPTS, valuesSchema } from './scripts'

export const injectionBindingSchema = z.object({ scriptId: z.uuid(), enabled: z.boolean().default(true), values: valuesSchema.default({}) }).strict()
export const injectionBindingsSchema = z.array(injectionBindingSchema).max(MAX_SCRIPTS).refine((items) => new Set(items.map((item) => item.scriptId)).size === items.length, '不能重复绑定同一注入脚本').default([])
export type InjectionBinding = z.output<typeof injectionBindingSchema>
export type InjectionState = { scriptId: string; name: string; revision: string; runId: string; phase: 'initializing' | 'active' | 'disabled' | 'stopped'; error?: string }
export const INTERCEPT_TIMEOUT = 10000
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
export const headerSchema = z.object({ name: z.string().min(1).max(1024).regex(/^[!#$%&'*+.^\w`|~-]+$/), value: z.string().max(65536).regex(/^[^\r\n]*$/) }).strict()
export const headersSchema = z.array(headerSchema).max(500)
export type Header = z.infer<typeof headerSchema>
export type NetworkRequest = { url: string; method: string; headers: Header[]; postData?: string; resourceType: string }
export type NetworkResponse = { status: number; headers: Header[]; body: string }
export const responsePatchSchema = z.object({ status: z.number().int().min(200).max(599).optional(), headers: headersSchema.optional(), body: z.string().max(MAX_RESPONSE_BYTES).optional() }).strict()
export const requestPatchSchema = z.object({
  url: z.string().max(4096).url().refine((value) => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password }).optional(),
  method: z.string().regex(/^[A-Z]+$/).max(40).optional(), headers: headersSchema.optional(), postData: z.string().max(MAX_RESPONSE_BYTES).optional(),
  abort: z.boolean().optional(), respond: responsePatchSchema.extend({ status: z.number().int().min(200).max(599) }).optional()
}).strict()
export type RequestPatch = z.infer<typeof requestPatchSchema>
export type ResponsePatch = z.infer<typeof responsePatchSchema>
export type InjectionScript = { script: SavedScript; values: InjectionBinding['values']; moduleRoot: string }
export type InjectionSite = { id: string; name: string; url: string }
export type InjectionWorkerInput = { endpoint: string; site: InjectionSite; scripts: InjectionScript[]; connectionOptions?: BrowserConnectionOptions }
export type Hook = { id: string; scriptId: string; tabId: string; stage: 'request' | 'response'; urlPattern: string }
export type WorkerOperation =
  | { type: 'install'; scriptId: string; tabId: string; targetId: string; currentUrl: string }
  | { type: 'ready' }
  | { type: 'navigationTimeout'; seconds: number }
  | { type: 'dispose'; tabId: string }
  | { type: 'disable'; scriptId: string }
  | { type: 'invoke'; hookId: string; payload: NetworkRequest | { request: NetworkRequest; response: NetworkResponse } }
  | { type: 'shutdown' }
export type InjectionCommand = (WorkerOperation & { id: number }) | { type: 'dataReply'; reply: DataReply } | { type: 'captureReply'; reply: CaptureReply }
export type InjectionMessage =
  | (CaptureRequest & { scriptId: string; tabId: string })
  | (NotifyWorkerMessage & { scriptId: string; tabId: string })
  | { type: 'reply'; id: number; value?: unknown; error?: string }
  | { type: 'data'; id: string; scriptId: string; tabId: string; op: DataOp; payload: unknown }
  | { type: 'hook'; hook: Hook }
  | { type: 'unhook'; id: string }
  | { type: 'log'; scriptId: string; log: ScriptLog }
  | { type: 'heartbeat' }
  | { type: 'initialized'; scriptId: string; tabId: string }

export function matchesPattern(pattern: string, url: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`).test(url)
}
export function bindingFingerprint(bindings: InjectionBinding[], scripts: { id: string; updatedAt: string }[]): string {
  return JSON.stringify(bindings.map((binding) => ({ ...binding, values: Object.fromEntries(Object.entries(binding.values).sort(([a], [b]) => a.localeCompare(b))), revision: scripts.find((script) => script.id === binding.scriptId)?.updatedAt })))
}
