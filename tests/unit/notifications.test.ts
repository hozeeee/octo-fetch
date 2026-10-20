import type { Socket } from 'node:net'
import type { Worker } from 'node:worker_threads'
import type { BrowserManager } from '../../src/main/browser/manager'
import type { Delivery } from '../../src/main/notifications/adapters'
import type { Encryptor } from '../../src/main/storage/store'
import type { NotificationConfig, NotificationLog, NotificationRequest } from '../../src/shared/notifications'
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import nodemailer from 'nodemailer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCRIPT_TOOLS } from '../../src/main/mcp/scripts'
import { httpPayload, NotificationError, sendNotification } from '../../src/main/notifications/adapters'
import { NotificationService } from '../../src/main/notifications/service'
import { NotificationLogStore, NotificationVault } from '../../src/main/notifications/store'
import { createNotify } from '../../src/main/scripts/notify'
import { ScriptRunner } from '../../src/main/scripts/runner'
import { ScriptLogStore, ScriptStore } from '../../src/main/scripts/store'
import { ConfigStore } from '../../src/main/storage/store'
import { channelDraftSchema, channelKeySchema, notificationConfigSchema, notificationHeadersSchema, notificationMessageSchema, notificationTerminal } from '../../src/shared/notifications'
import { scriptDraftSchema } from '../../src/shared/scripts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup() })
const testConfig: NotificationConfig = { kind: 'webhook', url: 'https://receiver.example/notify?token=private-token', headers: [{ name: 'Authorization', value: 'Bearer private-header' }], allowHttp: false }
const draft = (key = 'ops') => channelDraftSchema.parse({ key, name: `通知-${key}`, kind: 'webhook' })
const request = (targets = ['ops']): NotificationRequest => ({ id: randomUUID(), targets, message: { title: '标题', content: '私有正文' } })
const delivery: Delivery = { id: randomUUID(), createdAt: new Date().toISOString(), source: { kind: 'test' }, message: { title: '标题', content: '正文' }, prefix: '前缀' }
function encryptor(): Encryptor {
  const key = randomBytes(32)
  return {
    async encrypt(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]) },
    async decrypt(data) { const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); decipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString() }
  }
}
async function fixture(deliver = vi.fn<typeof sendNotification>().mockResolvedValue(undefined)) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'octo-notifications-'))
  const config = new ConfigStore(directory), vault = new NotificationVault(directory, encryptor()), logs = new NotificationLogStore(directory)
  const service = new NotificationService(config, vault, logs, vi.fn(), deliver)
  cleanups.push(() => service.shutdown())
  const { kind: _kind, ...settings } = testConfig
  await service.save(undefined, draft(), settings)
  return { directory, config, vault, logs, service, deliver, settings, channel: config.get().notifications[0] }
}
const finished = async (logs: NotificationLogStore, count: number) => vi.waitFor(() => {
  expect(logs.list({ pageSize: 100 }).items.filter((item) => notificationTerminal(item.status))).toHaveLength(count)
})

describe('通知契约与网络安全', () => {
  it('校验稳定标识、UTF-8 大小、官方地址和 Header，不因无效 URL 抛出解析异常', () => {
    for (const key of ['a', 'OPS', 'x.y', ' ops']) expect(channelKeySchema.safeParse(key).success).toBe(false)
    expect(channelKeySchema.safeParse('daily-mail_2').success).toBe(true)
    expect(notificationMessageSchema.safeParse({ content: '中'.repeat(6000) }).success).toBe(false)
    for (const url of ['bad', 'http://oapi.dingtalk.com/robot/send?access_token=x', 'https://oapi.dingtalk.com.evil.test/robot/send?access_token=x']) expect(notificationConfigSchema.safeParse({ kind: 'dingtalk', url }).success).toBe(false)
    expect(notificationConfigSchema.safeParse({ ...testConfig, url: 'http://127.0.0.1/test' }).success).toBe(false)
    expect(notificationConfigSchema.safeParse({ ...testConfig, url: 'http://127.0.0.1/test', allowHttp: true }).success).toBe(true)
    for (const name of ['Host', 'content-length', 'Cookie', 'connection']) expect(notificationHeadersSchema.safeParse([{ name, value: 'x' }]).success).toBe(false)
    expect(notificationHeadersSchema.safeParse([{ name: 'Authorization', value: 'x\r\nHost:evil' }]).success).toBe(false)
  })
  it('钉钉与飞书签名和时间单位正确，企业微信按 UTF-8 字节校验', () => {
    const now = 1700000000123
    const ding = httpPayload({ kind: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=x', secret: 'test-sign' }, delivery, now)
    expect(new URL(ding.url).searchParams.get('timestamp')).toBe(String(now))
    expect(new URL(ding.url).searchParams.get('sign')).toBe(createHmac('sha256', 'test-sign').update(`${now}\ntest-sign`).digest('base64'))
    expect(JSON.parse(ding.body)).toEqual({ msgtype: 'text', text: { content: '前缀\n标题\n正文' } })
    const feishu = JSON.parse(httpPayload({ kind: 'feishu', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test', secret: 'test-sign' }, delivery, now).body)
    expect(feishu.timestamp).toBe('1700000000')
    expect(feishu.sign).toBe(createHmac('sha256', '1700000000\ntest-sign').update('').digest('base64'))
    expect(() => httpPayload({ kind: 'wecom', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x' }, { ...delivery, message: { title: '', content: '中'.repeat(700) } })).toThrow('2048')
  })
  it('统一 Webhook 不包含凭据或页面上下文，禁止重定向并检验平台业务码', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await sendNotification(testConfig, delivery, new AbortController().signal)
    const options = fetchMock.mock.calls[0][1]!
    expect(options).toMatchObject({ method: 'POST', redirect: 'manual', credentials: 'omit' })
    expect(JSON.parse(String(options.body))).toEqual({ id: delivery.id, title: '标题', content: '前缀\n正文', createdAt: delivery.createdAt, source: { kind: 'test' } })
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }))
    await expect(sendNotification(testConfig, delivery, new AbortController().signal)).rejects.toMatchObject({ code: 'HTTP_302' })
    const wecom: NotificationConfig = { kind: 'wecom', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x' }
    fetchMock.mockResolvedValueOnce(new Response('{"errcode":40001,"errmsg":"private-token"}'))
    await expect(sendNotification(wecom, delivery, new AbortController().signal)).rejects.toMatchObject({ code: 'PLATFORM_40001', message: expect.not.stringContaining('private-token') })
    fetchMock.mockResolvedValueOnce(new Response('{"errcode":0}'))
    await expect(sendNotification(wecom, delivery, new AbortController().signal)).resolves.toBeUndefined()
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(65537)))
    await expect(sendNotification(wecom, delivery, new AbortController().signal)).rejects.toMatchObject({ code: 'RESPONSE_LIMIT', unknown: true })
  })
  it.each(['tls', 'starttls'] as const)('SMTP %s 取消会关闭真实 socket，不泄漏认证和正文', async (security) => {
    const sockets = new Set<Socket>(), chunks: Buffer[] = []
    const server = createServer((socket) => {
      sockets.add(socket); socket.on('error', () => undefined); socket.on('close', () => sockets.delete(socket))
      socket.on('data', (chunk) => chunks.push(chunk))
      if (security === 'starttls') socket.write('220 local test\r\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()) }))
    const config = notificationConfigSchema.parse({ kind: 'smtp', host: '127.0.0.1', port: (server.address() as { port: number }).port, security, username: 'test-user', password: 'private-password', from: 'from@example.com', to: ['to@example.com'] })
    const controller = new AbortController(), sending = sendNotification(config, delivery, controller.signal)
    const rejected = expect(sending).rejects.toMatchObject({ code: 'SMTP_NETWORK' })
    await vi.waitFor(() => expect(chunks.length).toBeGreaterThan(0))
    controller.abort()
    await vi.waitFor(() => expect(sockets.size).toBe(0)); await rejected
    const captured = Buffer.concat(chunks).toString()
    expect(captured).not.toContain('AUTH'); expect(captured).not.toContain('private-password'); expect(captured).not.toContain('正文')
  })
  it('SMTP 拒绝 STARTTLS 时不降级为明文认证', async () => {
    const commands: string[] = [], sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket); socket.on('error', () => undefined); socket.on('close', () => sockets.delete(socket))
      socket.write('220 local test\r\n')
      socket.on('data', (data) => {
        const text = data.toString(); commands.push(text)
        socket.write(text.startsWith('EHLO') ? '250-local\r\n250 AUTH PLAIN\r\n' : '454 TLS unavailable\r\n')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()) }))
    const config = notificationConfigSchema.parse({ kind: 'smtp', host: '127.0.0.1', port: (server.address() as { port: number }).port, security: 'starttls', username: 'test-user', password: 'private-password', from: 'from@example.com', to: ['to@example.com'] })
    await expect(sendNotification(config, delivery, new AbortController().signal)).rejects.toMatchObject({ code: 'SMTP_NETWORK' })
    expect(commands.join('')).toContain('STARTTLS')
    expect(commands.join('')).not.toContain('AUTH'); expect(commands.join('')).not.toContain('DATA')
  })
  it('SMTP 强制 TLS 并禁用文件/URL 读取，部分收件人拒绝和认证错误脱敏', async () => {
    const smtp = notificationConfigSchema.parse({ kind: 'smtp', host: 'smtp.example.com', port: 587, security: 'starttls', username: 'user', password: 'private-password', from: 'from@example.com', to: ['to@example.com'] })
    const sendMail = vi.fn().mockResolvedValue({ accepted: ['to@example.com'], rejected: [] }), close = vi.fn()
    const create = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail, close } as unknown as ReturnType<typeof nodemailer.createTransport>)
    await sendNotification(smtp, delivery, new AbortController().signal)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: true, tls: { rejectUnauthorized: true }, disableFileAccess: true, disableUrlAccess: true }))
    expect(close).toHaveBeenCalledOnce()
    sendMail.mockResolvedValueOnce({ accepted: ['to@example.com'], rejected: ['bad@example.com'] })
    await expect(sendNotification(smtp, delivery, new AbortController().signal)).rejects.toMatchObject({ code: 'SMTP_PARTIAL' })
    sendMail.mockRejectedValueOnce({ code: 'EAUTH', message: 'private-password' })
    await expect(sendNotification(smtp, delivery, new AbortController().signal)).rejects.toMatchObject({ code: 'SMTP_AUTH', message: expect.not.stringContaining('private-password') })
  })
})

describe('通知配置和日志持久化', () => {
  it('敏感配置不进元数据、备份、摘要或编辑回读，局部更新保留凭据', async () => {
    const f = await fixture()
    await f.service.save(f.channel.id, { ...draft(), name: '新名称' }, {})
    const next = f.config.get().notifications[0]
    expect(next.credentialId).not.toBe(f.channel.credentialId)
    expect(await f.vault.read(next.credentialId)).toEqual(testConfig)
    const exposed = JSON.stringify([f.config.get(), f.service.list(), await f.service.detail(next.id)])
    for (const text of ['private-token', 'private-header', 'receiver.example']) expect(exposed).not.toContain(text)
    for (const file of ['config.json', 'config.json.bak']) expect(await readFile(path.join(f.directory, file), 'utf8')).not.toContain('private-token')
    expect((await readdir(path.join(f.directory, 'notification-credentials')))).toContain(`${f.channel.credentialId}.enc`)
    await expect(f.service.save(f.channel.id, { ...draft(), key: 'changed' }, {})).rejects.toThrow('不可修改')
    await expect(f.service.save(undefined, draft(), f.settings)).rejects.toThrow('已被使用')
    await f.service.save(f.channel.id, draft(), { headers: null })
    expect(await f.vault.read(f.config.get().notifications[0].credentialId)).toMatchObject({ headers: [] })
  })
  it('旧配置默认无通知；加密失败不改配置，损坏凭据可完整替换', async () => {
    const f = await fixture()
    const { notifications: _notifications, ...old } = f.config.get()
    await writeFile(f.config.file, JSON.stringify(old))
    const legacy = new ConfigStore(f.directory); await legacy.initialize()
    expect(legacy.get().notifications).toEqual([])
    const prior = f.config.get()
    vi.spyOn(f.vault, 'create').mockRejectedValueOnce(new Error('加密失败'))
    await expect(f.service.save(f.channel.id, draft(), {})).rejects.toThrow()
    expect(f.config.get()).toEqual(prior)
    await writeFile(path.join(f.directory, 'notification-credentials', `${f.channel.credentialId}.enc`), 'broken')
    await expect(f.service.save(f.channel.id, draft(), {})).rejects.toThrow('完整配置')
    await f.service.save(f.channel.id, draft(), f.settings)
    expect(await f.vault.read(f.config.get().notifications[0].credentialId)).toEqual(testConfig)
  })
  it('恢复备份后仍能解密备份引用的凭据', async () => {
    const f = await fixture()
    await f.service.save(f.channel.id, draft(), { url: 'https://replacement.example/notify' })
    await writeFile(f.config.file, 'broken')
    const restored = new ConfigStore(f.directory); await restored.initialize()
    expect(restored.get().notifications[0].credentialId).toBe(f.channel.credentialId)
    expect(await f.vault.read(restored.get().notifications[0].credentialId)).toEqual(testConfig)
  })
  it('日志不保存正文，重启将残留记录改为中断/未知，清空保留活动记录', async () => {
    const f = await fixture()
    const sample: NotificationLog = { id: randomUUID(), submissionId: randomUUID(), key: 'ops', name: 'ops', title: '', source: { kind: 'test' }, createdAt: new Date().toISOString(), status: 'queued', count: 1 }
    f.logs.put(sample); f.logs.put({ ...sample, id: randomUUID(), status: 'sending' }); await f.logs.flush()
    const restarted = new NotificationLogStore(f.directory); await restarted.initialize()
    expect(restarted.list().items.map((item) => item.status)).toEqual(['unknown', 'interrupted'])
    restarted.clear(); restarted.put(sample); restarted.clear()
    expect(restarted.list().total).toBe(1); await restarted.flush()
    for (let i = 0; i < 1010; i++) f.logs.put({ ...sample, id: randomUUID(), status: 'accepted' })
    expect(f.logs.list().total).toBe(1002)
  })
  it('日志损坏原文件保留；写盘失败后内存仍可查询', async () => {
    const f = await fixture()
    await writeFile(f.logs.file, 'broken')
    await f.logs.initialize()
    f.service.submit(request(), { kind: 'test' }); await finished(f.logs, 1); await f.logs.flush()
    expect(f.logs.warning).toContain('原文件已保留')
    expect(await readFile(f.logs.file, 'utf8')).toBe('broken')
    const directory = await mkdtemp(path.join(os.tmpdir(), 'octo-log-fail-'))
    const logs = new NotificationLogStore(directory)
    await mkdir(logs.file)
    logs.put(f.logs.list().items[0]); await logs.flush()
    expect(logs.warning).toContain('写入失败'); expect(logs.list().total).toBe(1)
  })
})

describe('后台发送与主流程隔离', () => {
  it('多目标部分失败互不影响，错误脱敏，缺失/停用通道留痕', async () => {
    const f = await fixture(vi.fn<typeof sendNotification>().mockRejectedValue(new NotificationError('REJECTED', '测试拒绝')))
    f.service.submit(request(['ops', 'missing', 'ops']), { kind: 'action', runId: randomUUID() })
    await finished(f.logs, 2)
    expect(f.deliver).toHaveBeenCalledOnce()
    expect(f.logs.list().items.map((item) => item.code).sort()).toEqual(['NOT_FOUND', 'REJECTED'])
    expect(JSON.stringify(f.logs.list())).not.toContain('私有正文')
    await f.service.enable(f.channel.id, false)
    f.service.submit(request(), { kind: 'test' })
    expect(f.logs.list().items[0]).toMatchObject({ status: 'skipped', code: 'DISABLED' })
    expect(() => f.service.test(f.channel.id)).toThrow('先启用')
  })
  it('普通拒绝保留逐次提交关联 ID，只对超额拒绝合并计数', async () => {
    const f = await fixture()
    await f.service.enable(f.channel.id, false)
    const first = request(['ops', 'missing']), second = request(['ops', 'missing'])
    f.service.submit(first, { kind: 'test' }); f.service.submit(second, { kind: 'test' })
    expect(f.logs.list().total).toBe(4)
    for (const id of [first.id, second.id]) expect(f.logs.list().items.filter((item) => item.submissionId === id)).toHaveLength(2)
    expect(f.deliver).not.toHaveBeenCalled()
  })
  it('全局四并发、通道串行、投递使用提交时版本；停用阻止排队请求', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const f = await fixture(vi.fn<typeof sendNotification>().mockImplementation(() => gate))
    for (let i = 0; i < 4; i++) await f.service.save(undefined, draft(`channel-${i}`), f.settings)
    f.service.submit(request(['ops', 'channel-0', 'channel-1', 'channel-2', 'channel-3']), { kind: 'test' })
    f.service.submit(request(), { kind: 'test' })
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledTimes(4))
    await f.service.save(f.channel.id, { ...draft(), prefix: '新前缀' }, {})
    await f.service.enable(f.channel.id, false)
    expect(f.logs.list().items.filter((item) => item.code === 'DISABLED')).toHaveLength(1)
    release(); await finished(f.logs, 6)
    expect(f.deliver).toHaveBeenCalledTimes(5)
    expect(f.deliver.mock.calls[0][1].prefix).toBe('')
  })
  it('多次修改不回收在途版本，已排队通知保留旧地址和前缀', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const f = await fixture(vi.fn<typeof sendNotification>().mockResolvedValue(undefined).mockImplementationOnce(() => gate))
    f.service.submit(request(), { kind: 'test' }); f.service.submit(request(), { kind: 'test' })
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce())
    for (let i = 0; i < 3; i++) await f.service.save(f.channel.id, { ...draft(), prefix: `新前缀${i}` }, { url: `https://replacement.example/${i}` })
    expect(await f.vault.read(f.channel.credentialId)).toEqual(testConfig)
    release(); await finished(f.logs, 2)
    expect(f.deliver.mock.calls[1][0]).toEqual(testConfig)
    expect(f.deliver.mock.calls[1][1].prefix).toBe('')
    f.service.submit(request(), { kind: 'test' }); await finished(f.logs, 3)
    expect(f.deliver.mock.calls[2][0]).toMatchObject({ url: 'https://replacement.example/2' })
    expect(f.deliver.mock.calls[2][1].prefix).toBe('新前缀2')
  })
  it('排队超过六十秒不再发送，发送失败后不自动重试', async () => {
    const f = await fixture(vi.fn<typeof sendNotification>().mockImplementation(() => new Promise(() => undefined)))
    vi.spyOn(f.vault, 'read').mockResolvedValue(testConfig)
    vi.useFakeTimers()
    for (let i = 0; i < 10; i++) f.service.submit(request(), { kind: 'test' })
    await vi.advanceTimersByTimeAsync(60001)
    expect(f.deliver).toHaveBeenCalledTimes(4)
    expect(f.logs.list({ status: 'unknown' }).total).toBe(4)
    expect(f.logs.list({ status: 'failed' }).items).toHaveLength(6)
    expect(f.logs.list({ status: 'failed' }).items.every((item) => item.code === 'QUEUE_TIMEOUT')).toBe(true)
  })
  it('解密失败不发送；超时后的解密回调不能继续发出请求', async () => {
    const f = await fixture()
    vi.spyOn(f.vault, 'read').mockRejectedValueOnce(new Error('private-token'))
    f.service.submit(request(), { kind: 'test' }); await finished(f.logs, 1)
    expect(f.logs.list().items[0]).toMatchObject({ status: 'failed', code: 'CREDENTIALS' })
    expect(JSON.stringify(f.logs.list())).not.toContain('private-token')
    let release!: (config: NotificationConfig) => void
    vi.spyOn(f.vault, 'read').mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    vi.useFakeTimers()
    f.service.submit(request(), { kind: 'test' })
    await vi.advanceTimersByTimeAsync(15001)
    release(testConfig); await vi.advanceTimersByTimeAsync(1)
    expect(f.deliver).not.toHaveBeenCalled()
    expect(f.logs.list().items[0]).toMatchObject({ status: 'failed', code: 'ABORTED' })
  })
  it('退出后迟到的受理回调不改写未知结果', async () => {
    let release!: () => void
    const f = await fixture(vi.fn<typeof sendNotification>().mockImplementation(() => new Promise((resolve) => { release = resolve })))
    vi.spyOn(f.vault, 'read').mockResolvedValue(testConfig)
    vi.useFakeTimers()
    f.service.submit(request(), { kind: 'test' }); await vi.advanceTimersByTimeAsync(1)
    const shutdown = f.service.shutdown()
    await vi.advanceTimersByTimeAsync(5000); await shutdown
    release(); await vi.advanceTimersByTimeAsync(1)
    expect(f.logs.list().items[0]).toMatchObject({ status: 'unknown', code: 'CLOSING' })
  })
  it('每通道限流合并日志且没有自动重试', async () => {
    const f = await fixture()
    for (let i = 0; i < 50; i++) f.service.submit(request(), { kind: 'test' })
    await finished(f.logs, 21)
    expect(f.deliver).toHaveBeenCalledTimes(20)
    expect(f.logs.list({ status: 'skipped' }).items[0]).toMatchObject({ code: 'RATE_LIMIT', count: 30 })
  })
  it('队列最多 100，超额聚合；删除取消尚未发送的投递', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const f = await fixture(vi.fn<typeof sendNotification>().mockImplementation(() => gate))
    for (let i = 0; i < 6; i++) await f.service.save(undefined, draft(`channel-${i}`), f.settings)
    for (let i = 0; i < 20; i++) f.service.submit(request(['ops', ...Array.from({ length: 6 }, (_, n) => `channel-${n}`)]), { kind: 'test' })
    expect(f.logs.list({ status: 'queued', pageSize: 100 }).total).toBe(100)
    expect(f.logs.list({ status: 'skipped', pageSize: 100 }).items.reduce((sum, item) => sum + item.count, 0)).toBe(40)
    await f.service.remove(f.channel.id)
    release()
    await vi.waitFor(() => expect(f.logs.list({ status: 'queued' }).total + f.logs.list({ status: 'sending' }).total).toBe(0))
  })
  it('发送超时标为未知，退出在五秒预算内中断剩余投递', async () => {
    const f = await fixture(vi.fn<typeof sendNotification>().mockImplementation(() => new Promise(() => undefined)))
    vi.useFakeTimers()
    f.service.submit(request(), { kind: 'test' })
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(15000)
    expect(f.logs.list().items[0].status).toBe('unknown')
    f.service.submit(request(), { kind: 'test' }); f.service.submit(request(), { kind: 'test' })
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledTimes(2))
    const shuttingDown = f.service.shutdown()
    await vi.advanceTimersByTimeAsync(5000); await shuttingDown
    expect(f.logs.list().items.map((item) => item.status)).toEqual(['interrupted', 'unknown', 'unknown'])
    expect(f.deliver).toHaveBeenCalledTimes(2)
  })
  it('行动发出通知后立即完成，迟到通知失败不改写行动结果；MCP 只读摘要', async () => {
    let reject!: (error: Error) => void
    const gate = new Promise<void>((_resolve, fail) => { reject = fail })
    const f = await fixture(vi.fn<typeof sendNotification>().mockImplementation(() => gate))
    const store = new ScriptStore(f.directory), logs = new ScriptLogStore(f.directory)
    const site = { id: randomUUID(), tabId: randomUUID(), name: '测试', url: 'https://example.com', currentUrl: 'https://example.com' }
    const manager = { scriptSession: vi.fn().mockResolvedValue({ site, endpoint: '', targetId: '' }) } as unknown as BrowserManager
    const worker = Object.assign(new EventEmitter(), { terminate: vi.fn().mockResolvedValue(0) })
    const runner = new ScriptRunner(store, logs, manager, vi.fn(), () => worker as unknown as Worker, f.service)
    cleanups.push(() => runner.shutdown())
    const script = await runner.save(undefined, scriptDraftSchema.parse({ name: '通知行动', match: ['example.com'], source: 'return 1;' }), 'manual')
    const run = await runner.start({ scriptId: script.id, siteId: site.id, values: {} })
    worker.emit('message', { type: 'notify', request: request() })
    worker.emit('message', { type: 'done', result: '1', dropped: 0 })
    await vi.waitFor(() => expect(runner.active()).toHaveLength(0))
    reject(new NotificationError('TEST_FAILURE', '通知失败')); await finished(f.logs, 1)
    expect((await runner.runs(script.id))[0]).toMatchObject({ status: 'success', result: '1' })
    expect(f.logs.list({ runId: run.id }).items[0].source).toMatchObject({ scriptId: script.id, siteId: site.id })
    const channels = await SCRIPT_TOOLS.find((tool) => tool.name === 'list_notification_channels')!.run(manager, {}, runner)
    expect(JSON.stringify(channels)).not.toContain('private-token')
    expect(SCRIPT_TOOLS.filter((tool) => /notification/.test(tool.name)).every((tool) => tool.level === 'read')).toBe(true)
  })
})

describe('Worker 通知 API', () => {
  it('返回 void，数组去重，非法输入、发送异常和停止作用域都不抛错', () => {
    const send = vi.fn(), log = vi.fn(), notify = createNotify(send, log)
    expect(notify(['ops', 'ops'], '正文')).toBeUndefined()
    expect(send.mock.calls[0][0].request.targets).toEqual(['ops'])
    for (const input of [null, 123, {}, { content: '中'.repeat(6000) }]) expect(() => notify('ops', input)).not.toThrow()
    expect(send).toHaveBeenCalledOnce()
    send.mockImplementationOnce(() => { throw new Error('传输错误') })
    expect(() => notify('ops', '正文')).not.toThrow()
    createNotify(send, log, () => false)('ops', '正文')
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('高频调用在 Worker 内限流，超额仅写一条警告', () => {
    const send = vi.fn(), log = vi.fn(), notify = createNotify(send, log)
    for (let i = 0; i < 1000; i++) notify('ops', '正文')
    expect(send).toHaveBeenCalledTimes(60)
    expect(log.mock.calls.filter(([level]) => level === 'warn')).toHaveLength(1)
  })
})
