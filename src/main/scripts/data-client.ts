import type { DataOp, DataReply, DataRequest } from '../../shared/data-store'
import { randomUUID } from 'node:crypto'

// 脚本环境侧的数据仓库客户端：把 octo.data 调用封装成请求-应答，经各自传输通道发往主进程。
// 三种环境（行动/注入/沙箱）共用此工厂；send 由调用方补齐来源标识后再投递。
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
const REQUEST_TIMEOUT = 15000
const MAX_PER_MINUTE = 120

export function createDataClient(send: (request: DataRequest) => void, active: () => boolean = () => true) {
  const pending = new Map<string, Pending>()
  let windowAt = Date.now(), count = 0
  const request = (op: DataOp, payload: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (!active()) { reject(new Error('运行已结束，数据请求未提交')); return }
    if (Date.now() - windowAt >= 60000) { windowAt = Date.now(); count = 0 }
    if (++count > MAX_PER_MINUTE) { reject(new Error(`数据仓库每分钟最多请求 ${MAX_PER_MINUTE} 次，请降低调用频率`)); return }
    const id = randomUUID()
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('数据仓库请求超时')) }, REQUEST_TIMEOUT)
    pending.set(id, { resolve, reject, timer })
    try { send({ type: 'data', id, op, payload }) } catch (error) { pending.delete(id); clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) }
  })
  // octo.data：全部方法返回 Promise，主进程串行处理并原路回复。
  const data = Object.freeze({
    set: (collection: string, key: string, value: unknown, options?: { tags?: string[] }) => request('set', { collection, key, data: value, tags: options?.tags }),
    put: (collection: string, value: unknown, options?: { key?: string; tags?: string[] }) => request('put', { collection, key: options?.key, data: value, tags: options?.tags }),
    get: (collection: string, key: string) => request('get', { collection, key }),
    delete: async (collection: string, key: string) => ((await request('delete', { collection, key })) as { deleted: boolean }).deleted,
    query: (filter?: unknown) => request('query', filter ?? {}),
    list: (collection: string, filter?: Record<string, unknown>) => request('list', { ...(filter ?? {}), collection })
  })
  // 应答到达时结算对应 promise；命中返回 true，供多脚本共享 worker 时判定归属。
  const settle = (reply: DataReply): boolean => {
    const entry = pending.get(reply.id)
    if (!entry) return false
    pending.delete(reply.id); clearTimeout(entry.timer)
    if (reply.ok) entry.resolve(reply.value); else entry.reject(new Error(reply.error))
    return true
  }
  // 环境停止时拒绝全部在途请求，避免脚本永久挂起。
  const rejectAll = (message: string) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)) }
    pending.clear()
  }
  return { data, settle, rejectAll }
}
export type DataClient = ReturnType<typeof createDataClient>
