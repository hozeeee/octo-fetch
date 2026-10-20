import { captureProcessRequestSchema } from '../../shared/capture'
import { SerialQueue } from '../storage/store'
import { CaptureEngine } from './engine-adapter'

const port = process.parentPort!
const queue = new SerialQueue()
let engine: CaptureEngine | undefined
let heartbeat: ReturnType<typeof setInterval> | undefined
let lastPing = Date.now()
if (process.env.OCTO_CAPTURE_HEARTBEAT === '1') {
  setInterval(() => {
    if (Date.now() - lastPing > 45000) process.exit(1)
  }, 5000).unref()
}
port.on('message', ({ data }: { data: unknown }) => {
  if (data && typeof data === 'object' && 'type' in data && data.type === 'ping') { lastPing = Date.now(); return }
  const parsed = captureProcessRequestSchema.safeParse(data)
  if (!parsed.success) return
  const command = parsed.data
  void queue.run(async () => {
    try {
      let value: unknown
      if (command.op === 'start') {
        if (engine) throw new Error('抓包进程已初始化')
        engine = new CaptureEngine(command.generation)
        value = await engine.start(command.directory, command.settings, command.credentials)
        heartbeat = setInterval(() => port.postMessage({ type: 'count', count: engine?.count() || 0 }), 1000)
      } else {
        if (!engine) throw new Error('抓包服务尚未启动')
        switch (command.op) {
          case 'acquire': value = await engine.acquire(command.source, command.upstream, command.credentials); break
          case 'release': await engine.release(command.sourceId); break
          case 'query': value = engine.query(command.query); break
          case 'get': value = engine.detail(command.recordId, command.siteId); break
          case 'certificate': value = engine.certificatePem(); break
          case 'stop': clearInterval(heartbeat); await engine.stop(); break
        }
      }
      port.postMessage({ type: 'reply', id: command.id, ok: true, value })
      if (command.op === 'stop') setTimeout(() => process.exit(0), 20)
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? '抓包代理端口已占用，请修改端口或停止占用程序' : command.op === 'start' || command.op === 'acquire' ? '抓包启动或入口分配失败，请检查端口和原上游代理配置' : error instanceof Error ? error.message.slice(0, 300) : '抓包操作失败'
      port.postMessage({ type: 'reply', id: command.id, ok: false, error: reason })
    }
  })
})
