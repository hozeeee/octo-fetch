import type { Socket } from 'node:net'
import type { NotificationConfig, NotificationMessage, NotificationSource } from '../../shared/notifications'
import { createHmac } from 'node:crypto'
import { createConnection } from 'node:net'
import nodemailer from 'nodemailer'

export class NotificationError extends Error {
  constructor(readonly code: string, message: string, readonly unknown = false) { super(message) }
}
export type Delivery = { id: string; createdAt: string; source: NotificationSource; message: NotificationMessage; prefix: string }
export function httpPayload(config: Exclude<NotificationConfig, { kind: 'smtp' }>, delivery: Delivery, now = Date.now()) {
  const url = new URL(config.url)
  const content = [delivery.prefix, delivery.message.title, delivery.message.content].filter(Boolean).join('\n')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  let body: unknown
  if (config.kind === 'webhook') {
    for (const item of config.headers) headers[item.name] = item.value
    body = { id: delivery.id, title: delivery.message.title, content: [delivery.prefix, delivery.message.content].filter(Boolean).join('\n'), createdAt: delivery.createdAt, source: delivery.source }
  } else {
    const limit = config.kind === 'wecom' ? 2048 : config.kind === 'dingtalk' ? 20000 : 20000
    if (Buffer.byteLength(content) > limit) throw new NotificationError('CONTENT_LIMIT', `机器人正文（含前缀和标题）超过 ${limit} 字节限制`)
    if (config.kind === 'feishu') {
      const timestamp = String(Math.floor(now / 1000))
      body = { msg_type: 'text', content: { text: content }, ...(config.secret ? { timestamp, sign: createHmac('sha256', `${timestamp}\n${config.secret}`).update('').digest('base64') } : {}) }
    } else {
      if (config.kind === 'dingtalk' && config.secret) {
        const timestamp = String(now)
        url.searchParams.set('timestamp', timestamp)
        url.searchParams.set('sign', createHmac('sha256', config.secret).update(`${timestamp}\n${config.secret}`).digest('base64'))
      }
      body = { msgtype: 'text', text: { content } }
    }
  }
  const serialized = JSON.stringify(body)
  if (config.kind === 'feishu' && Buffer.byteLength(serialized) > 20000) throw new NotificationError('CONTENT_LIMIT', '飞书请求体超过 20,000 字节限制')
  return { url: url.href, headers, body: serialized }
}
async function readResponse(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  let length = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > 65536) throw new NotificationError('RESPONSE_LIMIT', '响应超过 64 KiB，无法确认结果', true)
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
export async function sendNotification(config: NotificationConfig, delivery: Delivery, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (config.kind === 'smtp') {
    let socket: Socket | undefined
    const transport = nodemailer.createTransport({
      host: config.host, port: config.port, secure: config.security === 'tls', requireTLS: config.security === 'starttls',
      auth: { user: config.username, pass: config.password }, tls: { rejectUnauthorized: true },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
      disableFileAccess: true, disableUrlAccess: true,
      // 普通 SMTP transport.close() 不关闭在途连接，底层 socket 必须受统一取消信号控制。
      getSocket: (_options, callback) => {
        if (signal.aborted) { callback(new NotificationError('ABORTED', '通知发送已停止')); return }
        const connection = createConnection({ host: config.host, port: config.port, signal })
        socket = connection
        const failed = (error: Error) => callback(error)
        connection.once('error', failed)
        connection.once('connect', () => {
          connection.removeListener('error', failed)
          callback(null, { connection })
        })
      }
    })
    const close = () => { socket?.destroy(); transport.close() }
    signal.addEventListener('abort', close, { once: true })
    try {
      const result = await transport.sendMail({ from: config.from, to: config.to, cc: config.cc, subject: delivery.message.title || 'Octo Fetch 通知', text: [delivery.prefix, delivery.message.content].filter(Boolean).join('\n') })
      if (result.rejected?.length) throw new NotificationError('SMTP_PARTIAL', '邮件服务器拒绝部分收件人，其他收件人可能已受理')
      if (!result.accepted?.length) throw new NotificationError('SMTP_REJECTED', '邮件服务器未受理收件人')
    } catch (error) {
      if (error instanceof NotificationError) throw error
      const code = (error as { code?: string }).code
      if (code === 'EAUTH') throw new NotificationError('SMTP_AUTH', 'SMTP 认证失败，请检查账号及授权码')
      if (code === 'EENVELOPE' || code === 'EMESSAGE') throw new NotificationError('SMTP_REJECTED', '邮件服务器拒绝消息或收件人')
      throw new NotificationError('SMTP_NETWORK', 'SMTP 连接中断或响应无法确认，请检查网络和 TLS 配置', true)
    } finally { signal.removeEventListener('abort', close); close() }
    return
  }
  const payload = httpPayload(config, delivery)
  let response: Response
  try { response = await fetch(payload.url, { method: 'POST', headers: payload.headers, body: payload.body, redirect: 'manual', credentials: 'omit', signal }) } catch { throw new NotificationError('HTTP_NETWORK', '通知连接失败或响应中断，无法确认是否送达', true) }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new NotificationError(`HTTP_${response.status}`, response.status >= 300 && response.status < 400 ? '接收端返回重定向，已禁止跟随' : `接收端返回 HTTP ${response.status}`)
  }
  if (config.kind === 'webhook') { await response.body?.cancel().catch(() => undefined); return }
  let data: Record<string, unknown>
  try {
    const parsed = JSON.parse(await readResponse(response))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('响应不是 JSON 对象')
    data = parsed
  } catch (error) {
    if (error instanceof NotificationError) throw error
    throw new NotificationError('INVALID_RESPONSE', '机器人响应无法解析，不能确认受理', true)
  }
  const code = config.kind === 'feishu' ? data.code ?? data.StatusCode : data.errcode
  if (code === 0) return
  if (typeof code !== 'number' || !Number.isSafeInteger(code)) throw new NotificationError('INVALID_RESPONSE', '机器人响应缺少有效业务状态，不能确认受理', true)
  throw new NotificationError(`PLATFORM_${code}`, `平台拒绝通知（${code}），请检查关键词、签名、机器人状态和频率限制`)
}
