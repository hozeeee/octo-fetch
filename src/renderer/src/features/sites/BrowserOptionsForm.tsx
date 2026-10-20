import type { BrowserOptions, ProxyCredentials } from '../../../../shared/browser-options'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { Alert, Button, Checkbox, Collapse, Input, InputNumber, Select, Space, Switch, Tag } from 'antd'
import { useState } from 'react'
import { DEVICE_LABELS, devicePreset } from '../../../../shared/browser-options'

export function BrowserOptionsForm({ value, onChange, version, savedCredentials, credentials, onCredentials, onInvalid }: {
  value: BrowserOptions; onChange(value: BrowserOptions): void; version: string; savedCredentials: boolean
  credentials?: ProxyCredentials | null; onCredentials(value: ProxyCredentials | null | undefined): void; onInvalid(error: string): void
}) {
  const [restorePreset, setRestorePreset] = useState(value.preset === 'custom' ? 'desktop' : value.preset)
  const [metadata, setMetadata] = useState(value.userAgentMetadata ? JSON.stringify(value.userAgentMetadata, null, 2) : '')
  const set = (patch: Partial<BrowserOptions>) => onChange({ ...value, ...patch })
  const device = (patch: Partial<BrowserOptions>) => set({ ...patch, preset: 'custom' })
  const viewport = (patch: Partial<BrowserOptions['viewport']>) => device({ viewport: { ...value.viewport, ...patch } })
  const choose = (preset: BrowserOptions['preset']) => {
    if (preset === 'custom') { set({ preset }); return }
    setRestorePreset(preset)
    const fields = devicePreset(preset, version)
    set(fields); setMetadata(fields.userAgentMetadata ? JSON.stringify(fields.userAgentMetadata, null, 2) : ''); onInvalid('')
  }
  const authenticated = credentials !== null && (Boolean(credentials) || savedCredentials)
  return <Collapse className="browser-options" defaultActiveKey={['device']} items={[
    { key: 'device', label: '设备与 UA', children: <>
      <p className="small muted">设备模拟仍使用 Chrome，不等于真实 iOS / Safari，也不保证网站设备识别或风控结果。</p>
      <label>设备预设<Select aria-label="设备预设" style={{ width: '100%', margin: '8px 0 16px' }} value={value.preset} onChange={choose} options={Object.entries(DEVICE_LABELS).map(([value, label]) => ({ value, label }))} /></label>
      <Space wrap align="end">
        <label>宽度（CSS px）<br /><InputNumber aria-label="视口宽度" min={240} max={3840} value={value.viewport.width} onChange={(n) => viewport({ width: n ?? 1280 })} /></label>
        <label>高度（CSS px）<br /><InputNumber aria-label="视口高度" min={240} max={3840} value={value.viewport.height} onChange={(n) => viewport({ height: n ?? 800 })} /></label>
        <label>DPR<br /><InputNumber aria-label="DPR" min={0.5} max={3} step={0.5} value={value.viewport.deviceScaleFactor} onChange={(n) => viewport({ deviceScaleFactor: n ?? 1 })} /></label>
        <Button onClick={() => viewport({ width: value.viewport.height, height: value.viewport.width, isLandscape: !value.viewport.isLandscape })}>{value.viewport.isLandscape ? '横屏 → 竖屏' : '竖屏 → 横屏'}</Button>
      </Space>
      <p><Checkbox checked={value.viewport.isMobile} onChange={(e) => viewport({ isMobile: e.target.checked })}>移动模式</Checkbox><Checkbox checked={value.viewport.hasTouch} onChange={(e) => viewport({ hasTouch: e.target.checked })}>触摸</Checkbox></p>
      <label>自定义 User-Agent<Input.TextArea aria-label="自定义 User-Agent" rows={3} value={value.userAgent ?? ''} onChange={(e) => { device({ userAgent: e.target.value, userAgentMetadata: undefined }); setMetadata(''); onInvalid('') }} placeholder="留空继承全局默认 UA；全局也未设置则使用浏览器默认 UA；不得包含换行或控制字符" /></label>
      <Button type="link" onClick={() => {
        const fields = devicePreset(restorePreset, version)
        device({ userAgent: fields.userAgent, platform: fields.platform, userAgentMetadata: fields.userAgentMetadata })
        setMetadata(fields.userAgentMetadata ? JSON.stringify(fields.userAgentMetadata, null, 2) : ''); onInvalid('')
      }}>恢复所选预设 UA</Button>
      <Collapse ghost items={[{ key: 'ua', label: '高级 UA 与 Client Hints', children: <>
        <label>navigator.platform<Input aria-label="navigator.platform" value={value.platform ?? ''} onChange={(e) => device({ platform: e.target.value })} /></label>
        <p className="small muted">自定义 UA 不推测系统信息。修改 UA 会清除旧 Client Hints；需要时可显式填写 JSON 元数据，iOS 预设不发送 Chromium Client Hints。</p>
        <label>UA Client Hints 元数据（JSON）<Input.TextArea aria-label="UA Client Hints 元数据" rows={5} value={metadata} placeholder={'{"platform":"Android","platformVersion":"11.0.0","architecture":"arm","model":"Pixel 5","mobile":true}'} onChange={(e) => {
          setMetadata(e.target.value)
          try { const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : undefined; device({ userAgentMetadata: parsed }); onInvalid('') } catch { onInvalid('UA Client Hints 元数据不是有效 JSON') }
        }} /></label>
      </> }]} />
    </> },
    { key: 'page', label: '页面行为', children: <>
      <p><Checkbox checked={value.javaScriptEnabled} onChange={(e) => set({ javaScriptEnabled: e.target.checked })}>启用 JavaScript</Checkbox><Checkbox checked={value.cacheEnabled} onChange={(e) => set({ cacheEnabled: e.target.checked })}>启用缓存</Checkbox></p>
      <Space wrap align="start">
        <label>语言<Input aria-label="语言" placeholder="跟随浏览器，如 zh-CN" value={value.locale ?? ''} onChange={(e) => set({ locale: e.target.value })} /></label>
        <label>时区<Input aria-label="时区" placeholder="跟随浏览器，如 Asia/Shanghai" value={value.timezone ?? ''} onChange={(e) => set({ timezone: e.target.value })} /></label>
        <label>导航超时（秒）<br /><InputNumber aria-label="网站导航超时" style={{ width: 170 }} min={10} max={120} placeholder="沿用全局配置" value={value.navigationTimeout} onChange={(n) => set({ navigationTimeout: n ?? undefined })} /></label>
      </Space>
      <p><Switch aria-label="模拟定位" checked={Boolean(value.geolocation)} onChange={(enabled) => set({ geolocation: enabled ? { latitude: 0, longitude: 0, accuracy: 0 } : undefined })} /> 模拟定位（只向配置网址的 origin 授权）</p>
      {value.geolocation && <Space wrap>{(['latitude', 'longitude', 'accuracy'] as const).map((key) => <label key={key}>{{ latitude: '纬度', longitude: '经度', accuracy: '精度（米）' }[key]}<br /><InputNumber aria-label={key} min={key === 'accuracy' ? 0 : key === 'latitude' ? -90 : -180} max={key === 'accuracy' ? 100000 : key === 'latitude' ? 90 : 180} value={value.geolocation![key]} onChange={(n) => set({ geolocation: { ...value.geolocation!, [key]: n ?? 0 } })} /></label>)}</Space>}
    </> },
    { key: 'headers', label: `额外请求头（${value.extraHTTPHeaders.length}）`, children: <>
      <Alert type="info" showIcon title="请求头是普通本地配置，请勿填写密钥。Cookie、认证和 UA/语言等受管理字段不允许在这里设置；登录信息请使用 Cookie 管理。" />
      {value.extraHTTPHeaders.map((header, index) => <Space.Compact key={index} style={{ width: '100%', marginTop: 8 }}>
        <Input aria-label={`请求头名称 ${index + 1}`} placeholder="名称" value={header.name} onChange={(e) => set({ extraHTTPHeaders: value.extraHTTPHeaders.map((h, i) => i === index ? { ...h, name: e.target.value } : h) })} />
        <Input aria-label={`请求头值 ${index + 1}`} placeholder="值" value={header.value} onChange={(e) => set({ extraHTTPHeaders: value.extraHTTPHeaders.map((h, i) => i === index ? { ...h, value: e.target.value } : h) })} />
        <Button aria-label="移除请求头" icon={<DeleteOutlined />} onClick={() => set({ extraHTTPHeaders: value.extraHTTPHeaders.filter((_, i) => i !== index) })} />
      </Space.Compact>)}
      <Button className="spaced" icon={<PlusOutlined />} disabled={value.extraHTTPHeaders.length >= 50} onClick={() => set({ extraHTTPHeaders: [...value.extraHTTPHeaders, { name: '', value: '' }] })}>添加请求头</Button>
    </> },
    { key: 'launch', label: '启动与网络', children: <>
      <p><Checkbox checked={value.headless} onChange={(e) => set({ headless: e.target.checked })}>无头模式</Checkbox><Checkbox checked={value.acceptInsecureCerts} onChange={(e) => set({ acceptInsecureCerts: e.target.checked })}>忽略证书错误</Checkbox></p>
      {!value.headless && <Alert className="spaced" type="info" title="非无头模式会打开独立 Chrome 窗口。" />}
      {value.acceptInsecureCerts && <Alert className="spaced" type="warning" showIcon title="忽略证书错误会降低连接安全性，仅在信任的测试环境启用。" />}
      <label>slowMo（毫秒） <InputNumber aria-label="slowMo" min={0} max={500} value={value.slowMo} onChange={(n) => set({ slowMo: n ?? 0 })} /></label>
      <p className="small muted">slowMo 不延长脚本任务的总执行预算。</p>
      <p><Switch aria-label="启用代理" checked={Boolean(value.proxy)} onChange={(enabled) => { set({ proxy: enabled ? { server: '', bypass: [] } : undefined }); if (!enabled) onCredentials(null) }} /> 启用代理</p>
      {value.proxy && <>
        <label>代理地址<Input aria-label="代理地址" placeholder="http://127.0.0.1:8080" value={value.proxy.server} onChange={(e) => set({ proxy: { ...value.proxy!, server: e.target.value } })} /></label>
        <p className="small muted">支持 HTTP / HTTPS / 无认证 SOCKS5。不允许内嵌账号密码；不保证覆盖 WebRTC 或其他浏览器旁路流量。</p>
        <label>绕过列表<Select aria-label="代理绕过列表" mode="tags" style={{ width: '100%' }} tokenSeparators={[',', ';']} value={value.proxy.bypass} onChange={(bypass) => set({ proxy: { ...value.proxy!, bypass } })} placeholder="输入主机、IP 或 *.example.com" /></label>
        <p><Switch aria-label="代理认证" checked={authenticated} onChange={(enabled) => onCredentials(enabled ? { username: '', password: '' } : null)} /> HTTP / HTTPS 代理认证 {savedCredentials && credentials === undefined && <Tag color="green">已保存</Tag>}</p>
        {authenticated && credentials === undefined && <Button onClick={() => onCredentials({ username: '', password: '' })}>替换已保存凭据</Button>}
        {authenticated && credentials && <Space style={{ width: '100%' }}>
          <Input aria-label="代理用户名" autoComplete="off" placeholder="用户名" value={credentials.username} onChange={(e) => onCredentials({ ...credentials, username: e.target.value })} />
          <Input.Password aria-label="代理密码" autoComplete="new-password" placeholder="密码" value={credentials.password} onChange={(e) => onCredentials({ ...credentials, password: e.target.value })} />
        </Space>}
        <p className="small muted">凭据单独加密保存，不回填旧密码。关闭认证将清除凭据引用。</p>
      </>}
    </> }
  ]} />
}
