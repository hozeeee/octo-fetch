import type { Runtime, Site, Target } from '../../../../shared/model'
import { ArrowLeftOutlined, ArrowRightOutlined, CopyOutlined, ExpandOutlined, GlobalOutlined, LockOutlined, PauseOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import { Alert, Button, Input, Modal, Space, Tabs, Tag, Tooltip } from 'antd'
import { useEffect, useState } from 'react'
import { useCommand, useDesktop } from '../../store'
import { CookieEditor } from '../sites/CookieEditor'
import { SiteAvatar, Status } from '../sites/Sites'
import { RemoteCanvas } from './RemoteCanvas'

function SiteCard({ site, runtime }: { site: Site; runtime?: Runtime }) {
  const command = useCommand()
  const setFocus = useDesktop((state) => state.setFocus)
  const running = runtime?.status === 'running'
  const busy = runtime?.status === 'starting' || runtime?.status === 'stopping'
  const active = runtime?.tabs.find((tab) => tab.id === runtime.activeTabId)
  return <article className="site-card">
    <div className="card-heading"><div className="site-cell"><SiteAvatar site={site} /><div><strong>{site.name}</strong><div className="small muted">{new URL(site.url).hostname}</div></div></div><Status status={runtime?.status} /></div>
    <button className="preview-button" aria-label={`放大 ${site.name}`} onClick={() => setFocus(site.id)}><RemoteCanvas runtime={runtime} siteId={site.id} /><span className="preview-hover"><ExpandOutlined /> 放大操作</span></button>
    {(runtime?.error || runtime?.warning) && <div className="card-warning">{runtime.error || runtime.warning}</div>}
    <div className="card-footer"><span className="small muted truncate">{running ? `${runtime.tabs.length} 个标签 · ${active?.title || '正在加载'}` : '独立会话 · 登录态保留'}</span><Space><Tooltip title="放大操作"><Button type="text" size="small" icon={<ExpandOutlined />} aria-label="放大操作" onClick={() => setFocus(site.id)} /></Tooltip><Button size="small" loading={busy} icon={running ? <PauseOutlined /> : <PlayCircleOutlined />} onClick={() => void command({ type: running ? 'browser.stop' : 'browser.start', siteId: site.id })}>{running ? '停止' : '启动'}</Button></Space></div>
  </article>
}

function runningViewport(runtime: Runtime | undefined, site: Site, geometry?: { width: number; height: number; scale: number }) {
  if (runtime?.status === 'running' && geometry) return { width: Math.round(geometry.width * geometry.scale), height: Math.round(geometry.height * geometry.scale) }
  return runtime?.status === 'running' || runtime?.status === 'starting' ? runtime.viewport ?? site.browserOptions.viewport : site.browserOptions.viewport
}

function FocusView({ site, runtime }: { site: Site; runtime?: Runtime }) {
  const command = useCommand()
  const setFocus = useDesktop((state) => state.setFocus)
  const active = runtime?.tabs.find((tab) => tab.id === runtime.activeTabId)
  const [address, setAddress] = useState(active?.url || site.url)
  const [cookies, setCookies] = useState(false)
  const [dialogText, setDialogText] = useState('')
  const [answeredId, setAnsweredId] = useState<string>()
  const frame = useDesktop((state) => state.frames[site.id])
  const geometry = frame?.generation === runtime?.generation && frame?.tabId === active?.id ? frame?.geometry : active?.geometry
  const viewport = runningViewport(runtime, site, geometry)
  useEffect(() => { setAddress(active?.url || site.url) }, [active?.url, active?.id, site.url])
  useEffect(() => { setDialogText(runtime?.dialog?.defaultValue || '') }, [runtime?.dialog?.id, runtime?.dialog?.defaultValue])
  const target: Target | undefined = runtime && active ? { siteId: site.id, generation: runtime.generation, tabId: active.id } : undefined
  const running = runtime?.status === 'running'
  // 应答后不等 snapshot 往返，先本地关闭对话框，否则遮罩层会拦住随后对画面的点击。
  const dialogOpen = Boolean(runtime?.dialog) && runtime?.dialog?.id !== answeredId
  const answer = (accept: boolean) => { if (target && runtime?.dialog) { setAnsweredId(runtime.dialog.id); void command({ type: 'dialog.answer', ...target, dialogId: runtime.dialog.id, accept, text: dialogText }) } }
  return <div className="focus-view">
    <div className="focus-heading"><Space><Button icon={<ArrowLeftOutlined />} onClick={() => setFocus(null)}>返回网格</Button><span className="divider-vertical" /><SiteAvatar site={site} /><strong>{site.name}</strong><Status status={runtime?.status} /></Space><Space><Button onClick={() => setCookies(true)}>Cookie 管理</Button><Button icon={<SaveOutlined />} disabled={!running} onClick={() => void command({ type: 'cookie.capture', siteId: site.id })}>保存登录态</Button><Button type={running ? 'default' : 'primary'} loading={runtime?.status === 'starting' || runtime?.status === 'stopping'} onClick={() => void command({ type: running ? 'browser.stop' : 'browser.start', siteId: site.id })}>{running ? '停止网站' : '启动网站'}</Button></Space></div>
    <div className="browser-shell">
      <div className="browser-tabs"><Tabs type="editable-card" size="small" activeKey={runtime?.activeTabId} hideAdd={!running} onChange={(tabId) => { if (runtime) void command({ type: 'tab.activate', siteId: site.id, generation: runtime.generation, tabId }) }} onEdit={(key, action) => {
        if (action === 'add') void command({ type: 'tab.new', siteId: site.id })
        else if (runtime && typeof key === 'string') void command({ type: 'tab.close', siteId: site.id, generation: runtime.generation, tabId: key })
      }} items={runtime?.tabs.map((tab) => ({ key: tab.id, label: <span className="tab-title">{tab.loading ? <ReloadOutlined spin /> : <GlobalOutlined />} {tab.title}</span> })) || []} /></div>
      <div className="address-toolbar"><Space size={3}>
        <Tooltip title="后退"><Button type="text" icon={<ArrowLeftOutlined />} disabled={!running} aria-label="后退" onClick={() => target && void command({ type: 'tab.back', ...target })} /></Tooltip>
        <Tooltip title="前进"><Button type="text" icon={<ArrowRightOutlined />} disabled={!running} aria-label="前进" onClick={() => target && void command({ type: 'tab.forward', ...target })} /></Tooltip>
        <Tooltip title="刷新"><Button type="text" icon={<ReloadOutlined spin={active?.loading} />} disabled={!running} aria-label="刷新" onClick={() => target && void command({ type: 'tab.reload', ...target })} /></Tooltip>
      </Space><Input prefix={<LockOutlined className="muted" />} value={address} aria-label="网页地址" onChange={(event) => setAddress(event.target.value)} onPressEnter={() => target && void command({ type: 'tab.navigate', ...target, url: address })} disabled={!running} spellCheck={false} /><Tooltip title="复制网页选中文本"><Button icon={<CopyOutlined />} disabled={!running} aria-label="复制网页选中文本" onClick={() => target && void command({ type: 'input', ...target, input: { type: 'copy' } })} /></Tooltip></div>
      {(runtime?.error || active?.error) && <Alert type="error" title={runtime?.error || active?.error} showIcon />}
      {runtime?.warning && <Alert type="warning" title={runtime.warning} showIcon />}
      <div className="focus-canvas"><RemoteCanvas key={`${runtime?.generation}-${active?.id}`} siteId={site.id} runtime={runtime} interactive /></div>
      <div className="browser-status"><span><i className="live-dot" />{running ? runtime.streamMode === 'fallback' ? '截图降级模式' : runtime.streamMode === 'paused' ? '画面已暂停' : '实时画面' : '网站未运行'}<span className="status-separator">/</span>{viewport.width} × {viewport.height}{runtime?.browserOptionsPending && <Tag color="orange">配置待重启生效</Tag>}</span><span>点击画面后输入 · 支持中文与 ⌘C / ⌘V</span><Tag bordered={false} color="green">独立登录态</Tag></div>
    </div>
    {cookies && <CookieEditor site={site} close={() => setCookies(false)} />}
    <Modal open={dialogOpen} title={`网站对话框 · ${runtime?.dialog?.type || ''}`} onOk={() => answer(true)} onCancel={() => answer(false)} maskClosable={false} transitionName="" maskTransitionName="" cancelButtonProps={{ disabled: runtime?.dialog?.type === 'alert' }}>
      <p className="dialog-content">{runtime?.dialog?.message}</p>{runtime?.dialog?.type === 'prompt' && <Input value={dialogText} onChange={(event) => setDialogText(event.target.value)} />}
    </Modal>
  </div>
}

export function Workspace({ add }: { add(): void }) {
  const snapshot = useDesktop((state) => state.snapshot)!
  const focus = useDesktop((state) => state.focus)
  const site = snapshot.config.sites.find((site) => site.id === focus)
  if (site) return <FocusView key={site.id} site={site} runtime={snapshot.runtimes.find((state) => state.siteId === site.id)} />
  const running = snapshot.runtimes.filter((item) => ['running', 'starting'].includes(item.status)).length
  return <>
    <div className="page-heading"><div><span className="eyebrow">YOUR LOCAL WORKSPACE</span><h1>工作台</h1><p>所有网站，一览即达。让多站点操作保持井然有序。</p></div><Button type="primary" icon={<PlusOutlined />} onClick={add}>添加网站</Button></div>
    <div className="overview-strip"><div><span className="stat-icon"><GlobalOutlined /></span><div><span className="muted">已配置网站</span><strong>{snapshot.config.sites.length}<small>个</small></strong></div></div><div><span className="stat-icon green"><PlayCircleOutlined /></span><div><span className="muted">运行中</span><strong>{running}<small>/ {snapshot.config.settings.maxRunning}</small></strong></div></div><div><span className="stat-icon"><LockOutlined /></span><div><span className="muted">会话隔离</span><strong className="stat-text">独立浏览器目录</strong></div></div><span className="local-badge"><i /> 数据仅存于本机</span></div>
    <div className="section-heading"><strong>网站总览 <span className="count">{snapshot.config.sites.length}</span></strong><span className="small muted">{snapshot.config.settings.gridFps} FPS 预览 · 点击画面放大操作</span></div>
    {snapshot.config.sites.length ? <div className="site-grid">{snapshot.config.sites.map((site) => <SiteCard key={site.id} site={site} runtime={snapshot.runtimes.find((item) => item.siteId === site.id)} />)}<button className="add-card" onClick={add}><PlusOutlined /><strong>添加一个网站</strong><span>新的页面，独立的工作空间</span></button></div> : <div className="workspace-empty"><div className="empty-illustration"><div className="empty-browser"><span>● ● ●</span><GlobalOutlined /></div><span className="empty-plus"><PlusOutlined /></span></div><h2>从你的第一个网站开始</h2><p>添加网站后即可实时预览、手动操作，<br />并为每个账号保留独立的登录状态。</p><Button type="primary" size="large" icon={<PlusOutlined />} onClick={add}>添加第一个网站</Button><div className="empty-features"><span>独立会话</span><span>实时画面</span><span>本地存储</span></div></div>}
  </>
}
