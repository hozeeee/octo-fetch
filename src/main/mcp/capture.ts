import type { Tool } from './tools'
import { z } from 'zod'
import { captureQuerySchema } from '../../shared/capture'
import { publicCaptureState } from '../capture/access'

const empty = z.object({}).strict()
const detail = z.object({ id: z.string().min(1).max(200) }).strict()
function tool(name: string, description: string, schema: z.ZodType, op: 'status' | 'query' | 'get' | 'start' | 'stop'): Tool {
  return {
    name, description, level: op === 'status' ? 'read' : 'full', input: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>,
    run: async (manager, raw) => {
      const args = schema.parse(raw ?? {})
      const service = manager.captureService
      if (!service) throw new Error('抓包模块不可用')
      const authorize = () => { if (!manager.store.get().capture.settings.allowMcp) throw new Error('请先在桌面开启“允许 MCP 访问抓包”') }
      let result: unknown
      if (op === 'status') {
        result = { ...publicCaptureState(service.state()), allowed: manager.store.get().capture.settings.allowMcp }
      } else {
        authorize()
        if (op === 'query') {
          result = await service.query(args)
        } else if (op === 'get') {
          result = await service.detail(detail.parse(args).id)
        } else {
          if (op === 'start') await service.start(authorize); else await service.stop(authorize)
          result = publicCaptureState(service.state())
        }
        authorize()
      }
      return [{ type: 'text', text: JSON.stringify(result) }]
    }
  }
}
export const CAPTURE_TOOLS: Tool[] = [
  tool('capture_status', '读取抓包服务的非敏感状态与 MCP 总开关；不返回流量、网站或管理鉴权。', empty, 'status'),
  tool('capture_requests', '查询本次运行的有界抓包缓存。URL 为子串，from/to 为毫秒时间戳；每页默认 50、最多 100，使用返回的 cursor 继续读取。包含敏感 URL，需完全权限及桌面授权。', captureQuerySchema, 'query'),
  tool('capture_detail', '按 generation:记录ID 按需读取 Header 和正文，各正文最多 1 MiB；保留截断和不可用标记。报文可能含 Cookie、Authorization、正文，勿无意转发。', detail, 'get'),
  tool('capture_start', '启动抓包服务，沿用桌面保存的配置；不会修改系统代理、证书或自动启动设置。', empty, 'start'),
  tool('capture_stop', '停止抓包服务；仍有关联网站时拒绝，不自动停止浏览器。外部客户端需手动撤销代理配置。', empty, 'stop')
]
