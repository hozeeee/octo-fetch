import type { NotifyWorkerMessage } from '../../shared/notifications'
import { randomUUID } from 'node:crypto'
import { channelKeySchema, notificationMessageSchema } from '../../shared/notifications'

export function createNotify(send: (message: NotifyWorkerMessage) => void, log: (level: 'info' | 'warn', text: string) => void, active: () => boolean = () => true) {
  let windowAt = Date.now(), count = 0
  return (target: unknown, message: unknown): void => {
    try {
      if (Date.now() - windowAt >= 60000) { windowAt = Date.now(); count = 0 }
      if (++count > 60) { if (count === 61) log('warn', '通知每分钟最多提交 60 次，后续超额调用在本窗口内忽略'); return }
      if (!active()) { log('warn', '注入已停止，通知未提交'); return }
      const targets = typeof target === 'string' ? [target] : target
      if (!Array.isArray(targets) || !targets.length || targets.length > 10 || !targets.every((key) => channelKeySchema.safeParse(key).success)) {
        log('warn', '通知目标必须是有效通道标识或最多 10 个标识的数组'); return
      }
      const parsed = notificationMessageSchema.safeParse(typeof message === 'string' ? { content: message } : message)
      if (!parsed.success) { log('warn', '通知格式无效：标题最多 200 字符，正文须为非空文本且不超过 16 KiB UTF-8'); return }
      const id = randomUUID()
      send({ type: 'notify', request: { id, targets: [...new Set(targets)], message: parsed.data } })
      log('info', `通知已提交 ${id}；最终结果请查看关联通知日志`)
    } catch { try { log('warn', '通知提交失败，主流程继续') } catch { /* 日志失败同样不能改变脚本结果。 */ } }
  }
}
