import type { CaptureDetail, CaptureOp, CapturePage, CaptureQuery, CaptureReply, CaptureRequest, CaptureState } from '../../shared/capture'
import { randomUUID } from 'node:crypto'
import { CAPTURE_REQUEST_TIMEOUT } from '../../shared/capture'

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export function createCaptureClient(send: (request: CaptureRequest) => void, active: () => boolean = () => true) {
  const pending = new Map<string, Pending>()
  let closed = false, at = Date.now(), count = 0
  const request = <T>(op: CaptureOp, payload?: unknown) => new Promise<T>((resolve, reject) => {
    if (closed || !active()) { reject(new Error('运行已停止，抓包请求未提交')); return }
    if (Date.now() - at >= 60000) { at = Date.now(); count = 0 }
    if (++count > 120) { reject(new Error('抓包每分钟最多请求 120 次')); return }
    const id = randomUUID(), deadline = Date.now() + CAPTURE_REQUEST_TIMEOUT
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('抓包请求超时')) }, CAPTURE_REQUEST_TIMEOUT)
    pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
    try { send({ type: 'capture', id, op, payload, deadline }) } catch (error) { clearTimeout(timer); pending.delete(id); reject(error) }
  })
  const capture = Object.freeze({
    status: () => request<Pick<CaptureState, 'status' | 'port' | 'pending'>>('status'),
    query: (filter?: CaptureQuery) => request<CapturePage>('query', filter ?? {}),
    get: (id: string) => request<CaptureDetail>('get', id),
    start: () => request<Pick<CaptureState, 'status' | 'port' | 'pending'>>('start'),
    stop: () => request<Pick<CaptureState, 'status' | 'port' | 'pending'>>('stop')
  })
  const settle = (reply: CaptureReply) => {
    const entry = pending.get(reply.id)
    if (!entry) return false
    pending.delete(reply.id); clearTimeout(entry.timer)
    if (reply.ok) entry.resolve(reply.value); else entry.reject(new Error(reply.error))
    return true
  }
  const close = () => {
    closed = true
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('运行已停止，抓包请求已取消')) }
    pending.clear()
  }
  return { capture, settle, close }
}
export type CaptureClient = ReturnType<typeof createCaptureClient>
