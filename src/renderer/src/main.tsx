import { ApiOutlined, AppstoreOutlined, BellOutlined, CodeOutlined, ControlOutlined, DatabaseOutlined, HddOutlined, PartitionOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { Alert, App as AntApp, ConfigProvider, Spin } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Capture } from './features/capture/Capture'
import { DataStore } from './features/data/DataStore'
import { Mcp } from './features/mcp/Mcp'
import { Notifications } from './features/notifications/Notifications'
import { Scripts } from './features/scripts/Scripts'
import { Settings } from './features/settings/Settings'
import { SiteForm, Sites } from './features/sites/Sites'
import { Tasks } from './features/tasks/Tasks'
import { Workspace } from './features/workspace/Workspace'
import { connectDesktop, useCommand, useDesktop } from './store'
import './styles.css'

function Logo() {
  return <svg width="32" height="32" viewBox="0 0 40 40" fill="none" aria-hidden="true"><rect width="40" height="40" rx="12" fill="#216b55" /><path d="M11 24v-7a9 9 0 0118 0v7M11 20c0 9-6 6-6 3m10-1c0 9-6 11-6 6m10-5v8m6-9c0 9 6 11 6 6m-2-8c0 9 6 6 6 3" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" /><circle cx="16" cy="17" r="1.4" fill="#fff" /><circle cx="24" cy="17" r="1.4" fill="#fff" /></svg>
}
function Application() {
  const snapshot = useDesktop((state) => state.snapshot)
  const error = useDesktop((state) => state.error)
  const view = useDesktop((state) => state.view)
  const focus = useDesktop((state) => state.focus)
  const setView = useDesktop((state) => state.setView)
  const command = useCommand()
  const [adding, setAdding] = useState(false)
  useEffect(connectDesktop, [])
  useEffect(() => {
    if (!snapshot) return
    const update = () => { void command({ type: 'view', siteId: view === 'workspace' ? focus : null, visible: view === 'workspace' && !document.hidden }) }
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [Boolean(snapshot), view, focus, command])
  const items = [
    { id: 'workspace' as const, label: '工作台', icon: <AppstoreOutlined /> },
    { id: 'sites' as const, label: '页面管理', icon: <DatabaseOutlined /> },
    { id: 'scripts' as const, label: '脚本能力', icon: <CodeOutlined /> },
    { id: 'tasks' as const, label: '任务编排', icon: <PartitionOutlined /> },
    { id: 'notifications' as const, label: '通知管理', icon: <BellOutlined /> },
    { id: 'data' as const, label: '数据仓库', icon: <HddOutlined /> },
    { id: 'capture' as const, label: '抓包调试', icon: <SafetyCertificateOutlined /> },
    { id: 'mcp' as const, label: 'MCP 服务', icon: <ApiOutlined /> },
    { id: 'settings' as const, label: '全局配置', icon: <ControlOutlined /> }
  ]
  return <div className="app-shell"><div className="titlebar"><span>Octo Fetch</span></div><aside className="sidebar"><div className="brand"><Logo /><div><strong>Octo Fetch</strong><span>多站点操作工作台</span></div></div><span className="nav-caption">工作空间</span><nav>{items.map((item) => <button key={item.id} onClick={() => setView(item.id)} className={view === item.id ? 'selected' : ''}>{item.icon}<span>{item.label}</span>{item.id === 'sites' && <small>{snapshot?.config.sites.length || 0}</small>}{item.id === 'scripts' && <small>{snapshot?.scripts.length || 0}</small>}{item.id === 'tasks' && <small>{snapshot?.config.tasks.length || 0}</small>}{item.id === 'data' && (snapshot?.data.total ? <small>{snapshot.data.total}</small> : null)}{item.id === 'mcp' && snapshot?.mcp.running && <small>ON</small>}</button>)}</nav><div className="sidebar-bottom"><div className="privacy-card"><SafetyCertificateOutlined /><strong>本地运行，独立会话</strong><p>你的登录数据保留在本机，<br />不同账号之间互不干扰。</p></div><div className="version"><span><i /> 桌面工作台</span><span>v{snapshot?.info.version || '0.1.0'}</span></div></div></aside>
    <main className={focus && view === 'workspace' ? 'main-content focused-content' : 'main-content'}>{error ? <Alert type="error" title={error} showIcon /> : !snapshot ? <div className="loading-page"><Spin size="large" /><p>正在连接本地工作台…</p></div> : <>{snapshot.warnings.map((warning) => <Alert key={warning} type="warning" title={warning} showIcon className="spaced" />)}{view === 'workspace' ? <Workspace add={() => setAdding(true)} /> : view === 'sites' ? <Sites add={() => setAdding(true)} /> : view === 'scripts' ? <Scripts /> : view === 'tasks' ? <Tasks /> : view === 'notifications' ? <Notifications /> : view === 'data' ? <DataStore /> : view === 'mcp' ? <Mcp /> : view === 'capture' ? <Capture /> : <Settings />}</>}</main>
    {adding && <SiteForm close={() => setAdding(false)} />}
  </div>
}
createRoot(document.getElementById('root')!).render(<ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#216b55', colorInfo: '#387f78', colorSuccess: '#27866b', colorText: '#263631', colorTextSecondary: '#7b8581', colorBorder: '#e2e7e4', borderRadius: 8, fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif', fontSize: 13, controlHeight: 32 }, components: { Button: { primaryShadow: '0 2px 3px rgba(33,107,85,.12)' }, Table: { headerBg: '#fafbfa', cellPaddingBlock: 10, cellPaddingInline: 14 }, Form: { itemMarginBottom: 16, verticalLabelPadding: '0 0 4px' }, Alert: { defaultPadding: '6px 12px', withDescriptionPadding: '10px 14px' }, Collapse: { headerPadding: '8px 14px', contentPadding: '10px 14px' } } }}><AntApp><Application /></AntApp></ConfigProvider>)
