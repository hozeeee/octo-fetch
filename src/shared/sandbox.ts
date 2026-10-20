import type { CaptureReply } from './capture'
import type { DataReply } from './data-store'
import { z } from 'zod'
import { captureRequestSchema } from './capture'
import { dataOpSchema } from './data-store'
import { notificationRequestSchema } from './notifications'
import { logSchema, MAX_OUTPUT, valuesSchema } from './scripts'

export const MAX_SANDBOXES = 4
export const sandboxInputSchema = z.object({
  runId: z.uuid(), scriptId: z.uuid(), source: z.string().max(200000),
  mode: z.enum(['once', 'service']), values: valuesSchema
}).strict()
export type SandboxInput = z.infer<typeof sandboxInputSchema>
const payload = {
  logs: z.array(logSchema).max(100), dropped: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  result: z.string().max(MAX_OUTPUT).optional()
}
export const sandboxMessageSchema = z.discriminatedUnion('type', [
  captureRequestSchema.extend({ runId: z.uuid() }).strict(),
  z.object({ type: z.literal('batch'), runId: z.uuid(), ...payload }).strict(),
  z.object({ type: z.enum(['ready', 'done']), runId: z.uuid(), ...payload, nodeVersion: z.string().max(80) }).strict(),
  z.object({ type: z.literal('failed'), runId: z.uuid(), ...payload, error: z.string().max(4000) }).strict(),
  z.object({ type: z.literal('disposed'), runId: z.uuid(), ...payload }).strict(),
  z.object({ type: z.literal('notify'), runId: z.uuid(), request: notificationRequestSchema }).strict(),
  z.object({ type: z.literal('data'), runId: z.uuid(), id: z.uuid(), op: dataOpSchema, payload: z.unknown() }).strict()
])
export type SandboxMessage = z.infer<typeof sandboxMessageSchema>
export type SandboxCommand = { type: 'start'; input: SandboxInput } | { type: 'stop' | 'ack'; runId: string } | { type: 'dataReply'; runId: string; reply: DataReply } | { type: 'captureReply'; runId: string; reply: CaptureReply }

export function serializeSandboxOutput(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item) => {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' || (typeof item === 'number' && !Number.isFinite(item))) throw new Error('结果必须可以无损转换为 JSON')
    return item
  })
  if (serialized === undefined) throw new Error('结果必须是 JSON 值')
  if (serialized.length > MAX_OUTPUT) throw new Error('输出结果超过 64K 字符，请减少数据')
  return serialized
}
