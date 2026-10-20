import type { CaptureReply, CaptureState } from '../../shared/capture'
import type { ConfigStore } from '../storage/store'
import type { CaptureService } from './service'
import { z } from 'zod'
import { CAPTURE_REQUEST_TIMEOUT, captureOpSchema, captureQuerySchema, captureRequestSchema } from '../../shared/capture'

type Source = { kind: 'action' | 'injection' | 'sandbox'; scriptId: string; siteId?: string }
// 低权限状态不包含流量、网站标识、地址、证书或原始错误。
export function publicCaptureState(state: CaptureState) {
  return { status: state.status, port: state.port, pending: state.pending }
}
export class CaptureAccess {
  private limits = new Map<string, { at: number; count: number }>()
  constructor(private store: ConfigStore, private service: CaptureService) {}
  async dispatch(rawOp: unknown, payload: unknown, source: Source, active: () => boolean, deadline = Date.now() + CAPTURE_REQUEST_TIMEOUT): Promise<unknown> {
    const op = captureOpSchema.parse(rawOp)
    const expires = Math.min(deadline, Date.now() + CAPTURE_REQUEST_TIMEOUT)
    const check = () => {
      if (Date.now() >= expires) throw new Error('抓包请求超时，未执行的操作已取消')
      if (!active()) throw new Error('脚本运行已停止，抓包请求已取消')
      const config = this.store.get().capture
      if (!config.settings.allowScripts) throw new Error('请先在桌面开启脚本抓包访问')
      const grant = config.grants[source.scriptId] || 'none'
      if (grant === 'none' || (['start', 'stop'].includes(op) && grant !== 'control')) throw new Error('此脚本没有所需的本机抓包授权')
      if (source.kind !== 'sandbox' && !source.siteId) throw new Error('抓包查询缺少可信网站上下文')
    }
    check()
    const now = Date.now()
    for (const [id, limit] of this.limits) {
      if (now - limit.at >= 60000) this.limits.delete(id)
    }
    let limit = this.limits.get(source.scriptId)
    if (!limit) { limit = { at: now, count: 0 }; this.limits.set(source.scriptId, limit) }
    if (++limit.count > 120) throw new Error('每个脚本每分钟最多访问抓包 120 次')
    let value: unknown
    if (op === 'status') {
      value = publicCaptureState(this.service.state())
    } else if (op === 'query') {
      const query = captureQuerySchema.parse(payload ?? {})
      if (source.kind !== 'sandbox') {
        if (query.external || (query.siteId && query.siteId !== source.siteId)) throw new Error('行动和注入只能读取当前网站的抓包')
        query.siteId = source.siteId
      }
      value = await this.service.query(query)
    } else if (op === 'get') {
      value = await this.service.detail(z.string().min(1).max(200).parse(payload), source.kind === 'sandbox' ? undefined : source.siteId)
    } else {
      // 控制在服务队列真正执行前再次校验，防止撤销授权或脚本停止后的排队操作。
      if (op === 'start') await this.service.start(check); else await this.service.stop(check)
      value = publicCaptureState(this.service.state())
    }
    check()
    return value
  }
  handle(raw: unknown, source: Source, active: () => boolean, send: (reply: CaptureReply) => void) {
    const parsed = captureRequestSchema.safeParse(raw)
    if (!parsed.success) return
    const request = parsed.data
    const reply = (result: Omit<Extract<CaptureReply, { ok: true }>, 'type' | 'id'> | Omit<Extract<CaptureReply, { ok: false }>, 'type' | 'id'>) => {
      try { send({ type: 'captureReply', id: request.id, ...result }) } catch { /* 运行可能已结束。 */ }
    }
    void this.dispatch(request.op, request.payload, source, active, request.deadline).then(
      (value) => reply({ ok: true, value }),
      (error) => reply({ ok: false, error: error instanceof z.ZodError ? '抓包参数格式无效' : String(error?.message || error).slice(0, 500) })
    )
  }
}
