import type { ProxyCredentials } from '../../../../shared/browser-options'
import type { CaptureSettings } from '../../../../shared/capture'
import { PlayCircleOutlined, PoweroffOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import { Alert, App, Button, Checkbox, Empty, Form, Input, InputNumber, Select, Space, Table, Tabs, Tag, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { captureSettingsSchema } from '../../../../shared/capture'
import { useCommand, useDesktop } from '../../store'
import { Status } from '../sites/Sites'

function Workbench() {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const generation = useDesktop((state) => state.snapshot?.capture.generation)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    let alive = true, last = ''
    const update = () => {
      const rect = element.getBoundingClientRect()
      const overlay = [...document.querySelectorAll('.ant-modal-mask, .ant-drawer-mask')].some((node) => (node as HTMLElement).offsetParent !== null)
      const bounds = { visible: !document.hidden && !overlay, x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.min(Math.round(rect.height), window.innerHeight - Math.round(rect.y))) }
      const key = JSON.stringify(bounds)
      if (last === key) return
      last = key
      void window.octo.captureView(bounds).then((reply) => { if (alive && !reply.ok) setError(reply.error) }).catch(() => { if (alive) setError('抓包工作台暂时不可用') })
    }
    const observer = new ResizeObserver(update), overlays = new MutationObserver(update)
    observer.observe(element); overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
    document.addEventListener('visibilitychange', update); window.addEventListener('scroll', update, true); window.addEventListener('resize', update)
    update()
    return () => { alive = false; observer.disconnect(); overlays.disconnect(); document.removeEventListener('visibilitychange', update); window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); void window.octo.captureView({ visible: false, x: 0, y: 0, width: 0, height: 0 }) }
  }, [generation])
  return <>{error && <Alert type="error" title={error} />}<div ref={ref} className="capture-workbench" aria-label="Whistle 抓包工作台" /></>
}
function Configuration() {
  const snapshot = useDesktop((state) => state.snapshot)!
  const settings = snapshot.config.capture.settings
  const [form] = Form.useForm()
  const command = useCommand(), { message } = App.useApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [authentication, setAuthentication] = useState<'keep' | 'replace' | 'clear'>('keep')
  return <section className="settings-panel"><div className="panel-title"><h3>启动配置</h3><p>保存与启停分离；网络配置修改后重启代理生效，不会中断当前网站连接。</p></div>
    {error && <Alert type="error" title={error} className="spaced" />}
    <Form layout="vertical" form={form} initialValues={{ ...settings, allowedIps: settings.allowedIps.join('\n'), server: settings.upstream?.server || '' }} onFinish={async (values) => {
      setBusy(true); setError('')
      try {
        const next: CaptureSettings = captureSettingsSchema.parse({ port: values.port, autoStart: values.autoStart, https: values.https, lan: values.lan, allowedIps: String(values.allowedIps || '').split(/[\s,]+/).filter(Boolean), upstream: values.server?.trim() ? { server: values.server.trim(), bypass: [] } : undefined, allowMcp: values.allowMcp, allowScripts: values.allowScripts })
        const credentials: ProxyCredentials | null | undefined = authentication === 'clear' ? null : authentication === 'replace' ? { username: values.username || '', password: values.password || '' } : undefined
        if (await command({ type: 'capture.save', settings: next, credentials })) { form.resetFields(['username', 'password']); setAuthentication('keep'); void message.success('抓包配置已保存；网络配置重启代理生效') }
      } catch { setError('配置无效：检查端口、客户端 IP 和无内嵌凭据的代理地址') } finally { setBusy(false) }
    }}>
      <div className="form-columns"><Form.Item name="port" label="公共代理端口"><InputNumber min={1024} max={65535} precision={0} style={{ width: '100%' }} /></Form.Item><Form.Item name="server" label="外部客户端默认上游" extra="留空直接出站；支持 HTTP / HTTPS / SOCKS5"><Input placeholder="http://127.0.0.1:8080" /></Form.Item></div>
      <Space wrap size={20}><Form.Item name="autoStart" valuePropName="checked"><Checkbox>应用启动时自动启动</Checkbox></Form.Item><Form.Item name="https" valuePropName="checked"><Checkbox>HTTPS 解密</Checkbox></Form.Item><Form.Item name="lan" valuePropName="checked"><Checkbox>允许局域网接入</Checkbox></Form.Item></Space>
      <Form.Item name="allowedIps" label="允许的客户端 IP" extra="每行一个 IPv4 / IPv6，不支持网段。开启局域网时必填；按真实连接地址校验，仅用于可信局域网。"><Input.TextArea rows={3} placeholder="192.168.1.10" /></Form.Item>
      <Form.Item label={`外部上游认证${snapshot.config.capture.credentialId ? '（已加密保存）' : '（未配置）'}`}><Select value={authentication} onChange={setAuthentication} options={[{ value: 'keep', label: '保留现有凭据' }, { value: 'replace', label: '替换凭据（仅 HTTP / HTTPS Basic）' }, { value: 'clear', label: '清除凭据' }]} /></Form.Item>
      {authentication === 'replace' && <div className="form-columns"><Form.Item name="username" label="代理用户名" rules={[{ required: true }]}><Input autoComplete="off" /></Form.Item><Form.Item name="password" label="代理密码"><Input.Password autoComplete="new-password" /></Form.Item></div>}
      <Space wrap size={20}><Form.Item name="allowMcp" valuePropName="checked"><Checkbox>允许 MCP 访问抓包</Checkbox></Form.Item><Form.Item name="allowScripts" valuePropName="checked"><Checkbox>允许脚本访问抓包（另需逐脚本授权）</Checkbox></Form.Item></Space>
      <Alert type="warning" showIcon title="完整 URL、Header 和正文均为敏感数据；只向可信客户端授权。代理上游证书仍严格校验，连接失败不会自动直连。" />
      <Button className="spaced" type="primary" htmlType="submit" loading={busy} icon={<SaveOutlined />}>保存抓包配置</Button>
    </Form>
  </section>
}
function Connections() {
  const snapshot = useDesktop((state) => state.snapshot)!, command = useCommand()
  const state = snapshot.capture
  return <>
    <section className="settings-panel"><div className="panel-title"><h3>客户端与证书</h3><p>本机客户端使用 127.0.0.1；其他设备使用下方局域网地址，并在启动配置中加入允许 IP。</p></div>
      <Space wrap>{state.addresses.map((address) => <Typography.Text key={address} code copyable>{address}</Typography.Text>)}</Space>
      <p>在浏览器、手机或应用中手动设置 HTTP / HTTPS 代理。HTTPS 解密还需导出并手动安装、信任 CA；iOS 需在“证书信任设置”启用完全信任。结束调试后手动撤销代理、移除 CA。</p>
      <div className="data-path">SHA-256：{state.fingerprint || '尚未生成，请先启动一次代理'}</div>
      <Space><Button disabled={!state.fingerprint} onClick={() => void command({ type: 'capture.certificate.export' })}>导出公开 CA</Button><Button danger disabled={!['stopped', 'error'].includes(state.status) || state.sites.length > 0} onClick={() => void command({ type: 'capture.certificate.reset' })}>重置 CA</Button></Space>
      <p className="small muted">不修改系统代理或钥匙串。证书固定、mTLS、未采用代理的应用可能无法解密；不支持通用 UDP / QUIC / HTTP3 抓包。</p>
    </section>
    <div className="table-panel spaced"><div className="panel-toolbar"><strong>网站一键接入</strong><span className="small muted">勾选后显式重启网站生效</span></div>
      <Table rowKey="id" dataSource={snapshot.config.sites} size="small" pagination={{ pageSize: 10 }} columns={[
        { title: '网站', dataIndex: 'name' },
        { title: '抓包', render: (_, site) => <Checkbox aria-label={`${site.name}接入抓包`} checked={site.captureEnabled} onChange={(event) => void command({ type: 'capture.site', siteId: site.id, enabled: event.target.checked })} /> },
        { title: '接入状态', render: (_, site) => { const runtime = snapshot.runtimes.find((item) => item.siteId === site.id); return <Tag color={runtime?.captureError ? 'red' : runtime?.capturePending ? 'orange' : runtime?.captureActive ? 'green' : undefined}>{runtime?.captureError ? '出口失效' : runtime?.capturePending ? '待重启' : runtime?.captureActive ? '已生效' : site.captureEnabled ? '待启动网站' : '未接入'}</Tag> } },
        { title: '原出口', render: (_, site) => site.browserOptions.proxy?.server || '直接出站' },
        { title: '操作', render: (_, site) => { const runtime = snapshot.runtimes.find((item) => item.siteId === site.id); return <Button size="small" disabled={runtime?.status === 'starting' || runtime?.status === 'stopping'} onClick={() => void command({ type: runtime?.status === 'running' ? 'browser.stop' : 'browser.start', siteId: site.id })}>{runtime?.status === 'running' ? '停止网站' : '启动网站'}</Button> } }
      ]} />
    </div>
    <Alert className="spaced" type="info" title="保留网站原代理、凭据和绕过列表；被绕过的请求不会被抓包。页面请求注入先于代理，代理响应改写先于页面响应注入；缓存、Service Worker 或 CDP Mock 可能不经过代理。" />
  </>
}
export function Capture() {
  const snapshot = useDesktop((state) => state.snapshot)!, command = useCommand()
  const [tab, setTab] = useState('workbench'), [busy, setBusy] = useState(false)
  const state = snapshot.capture
  const transitioning = busy || state.status === 'starting' || state.status === 'stopping'
  const control = async (type: 'capture.start' | 'capture.stop' | 'capture.restart') => { setBusy(true); try { await command({ type }) } finally { setBusy(false) } }
  return <div className="capture-page"><div className="page-heading"><div><span className="eyebrow">NETWORK INSPECTOR</span><h1>抓包调试</h1><p>Whistle 本地工作台 · 独立出口与 HTTPS 调试</p></div><Space><Status status={state.status} /><Button type="primary" icon={<PlayCircleOutlined />} disabled={transitioning || state.status === 'running'} onClick={() => void control('capture.start')}>启动代理</Button><Button icon={<PoweroffOutlined />} disabled={transitioning || state.status === 'stopped'} onClick={() => void control('capture.stop')}>停止</Button><Button icon={<ReloadOutlined />} disabled={transitioning || state.status !== 'running'} onClick={() => void control('capture.restart')}>重启</Button></Space></div>
    {state.error && <Alert className="spaced" type="error" title={state.error} />}
    {state.pending && <Alert className="spaced" type="warning" title="已保存的网络配置待重启代理生效；当前网站保持原启动出口。" />}
    <div className="small muted">代理端口 {state.port} · 关联网站 {state.sites.length} · 内存记录 {state.count}（缓存会淘汰，不是永久历史）</div>
    <Tabs activeKey={tab} onChange={setTab} items={[{ key: 'workbench', label: '工作台' }, { key: 'configuration', label: '启动配置' }, { key: 'connections', label: '接入与证书' }]} />
    {tab === 'configuration' ? <Configuration /> : tab === 'connections' ? <Connections /> : <><Alert type="warning" showIcon title="报文和原始导出可能含 Cookie、Authorization 与正文。规则可访问本机资源，仅执行可信规则；不启用第三方插件、Weinre 或云服务。" />{state.status === 'running' ? <Workbench /> : <Empty className="spaced" description="启动抓包代理后打开工作台" />}</>}
  </div>
}
