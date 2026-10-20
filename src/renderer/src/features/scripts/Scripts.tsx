import type { SavedScript, ScriptKind, ScriptSummary } from '../../../../shared/scripts'
import { CodeOutlined, ImportOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons'
import { App, Button, Collapse, Empty, Input, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { useState } from 'react'
import { MAX_SCRIPTS, SCRIPT_CONTRACT, SCRIPT_KINDS, scriptRunLabel } from '../../../../shared/scripts'
import { useCommand, useDesktop } from '../../store'
import { ScriptEditor } from './ScriptEditor'
import { ScriptLogs, ScriptRunForm } from './ScriptRun'

const ORIGIN = { agent: 'Agent 生成', manual: '手动创建', import: '文件导入' }
export function Scripts() {
  const snapshot = useDesktop((state) => state.snapshot)!
  const command = useCommand()
  const { message } = App.useApp()
  const [search, setSearch] = useState('')
  const [editor, setEditor] = useState<{ script?: SavedScript; kind?: ScriptKind }>()
  const [kind, setKind] = useState<ScriptKind | 'all'>('all')
  const [running, setRunning] = useState<SavedScript>()
  const [logs, setLogs] = useState<{ id: string; name: string }>()
  const [loading, setLoading] = useState(false)
  const open = async (id: string, action: 'edit' | 'run') => {
    if (loading) return
    setLoading(true)
    try {
      const reply = await window.octo.script(id)
      if (!reply.ok) { void message.error(reply.error); return }
      if (action === 'edit') setEditor({ script: reply.data }); else setRunning(reply.data)
    } catch { void message.error('无法读取脚本') } finally { setLoading(false) }
  }
  const scripts = snapshot.scripts.filter((script) => (kind === 'all' || script.draft.kind === kind) && `${script.draft.name} ${script.draft.description} ${script.draft.match.join(' ')} ${script.draft.dependencies.map((item) => item.name).join(' ')}`.toLowerCase().includes(search.toLowerCase()))
  const references = (id: string) => snapshot.config.sites.filter((site) => site.injections.some((binding) => binding.scriptId === id) || snapshot.runtimes.find((runtime) => runtime.siteId === site.id)?.injections?.some((item) => item.scriptId === id))
  return <>
    <div className="page-heading"><div><span className="eyebrow">REUSABLE CAPABILITIES</span><h1>脚本能力</h1><p>把网页操作、页面注入和独立 Node.js 脚本沉淀为可复用能力。</p></div><Space><Button icon={<ImportOutlined aria-hidden="true" />} disabled={snapshot.scripts.length >= MAX_SCRIPTS} onClick={() => void command({ type: 'script.import' })}>导入 .js</Button><Button type="primary" icon={<PlusOutlined aria-hidden="true" />} disabled={snapshot.scripts.length >= MAX_SCRIPTS} onClick={() => setEditor({ kind: kind === 'all' ? 'action' : kind })}>新建脚本</Button></Space></div>
    <section className="script-intro"><span className="stat-icon green"><CodeOutlined /></span><div><strong>让 Agent 为你生成，保留为自己的工具</strong><p>在 MCP 服务页给可信 Agent 三级权限，然后告诉它：“把这个操作生成为可复用脚本，并保存到 Octo Fetch。”</p><span className="muted small">网页与独立运行 · 变量可配置 · 日志可追溯 · 导出迁移不含登录态</span></div><div className="script-count"><strong>{snapshot.scripts.length}</strong><span>个已保存能力</span></div></section>
    <Collapse className="spaced" items={[{ key: 'guide', label: '编写契约与安全说明 · 浏览器 / Node.js / octo', children: <><Typography.Text copyable={{ text: SCRIPT_CONTRACT }}>复制编写契约</Typography.Text><pre className="script-guide">{SCRIPT_CONTRACT}</pre></> }]} />
    <Segmented className="spaced" aria-label="脚本分类" value={kind} onChange={setKind} options={[{ value: 'all', label: '全部' }, ...Object.entries(SCRIPT_KINDS).map(([value, label]) => ({ value: value as ScriptKind, label }))]} />
    <div className="script-list-heading"><Input prefix={<SearchOutlined />} placeholder="搜索名称、说明或域名" allowClear value={search} onChange={(event) => setSearch(event.target.value)} style={{ maxWidth: 360 }} /><span className="small muted">{snapshot.scriptRuns.filter((run) => run.kind !== 'sandbox').length} 个行动 / {snapshot.scriptRuns.filter((run) => run.kind === 'sandbox').length} 个沙箱运行中 · 数据保存在本机</span></div>
    <section className="table-panel"><Table<ScriptSummary> rowKey="id" scroll={{ x: 1150 }} loading={loading} dataSource={scripts} pagination={{ pageSize: 8, hideOnSinglePage: true }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={search ? '没有匹配的脚本' : '暂无脚本能力，让 Agent 生成或手动创建第一个脚本'} /> }} columns={[
      { title: '脚本 / 能力', key: 'name', render: (_, script) => <div><Tag color={script.draft.kind === 'sandbox' ? 'cyan' : script.draft.kind === 'injection' ? 'purple' : 'blue'}>{SCRIPT_KINDS[script.draft.kind]}</Tag><strong>{script.draft.name}</strong><div className="muted small script-description">{script.draft.description || '暂无说明'}</div></div> },
      { title: '运行环境 / 域名', key: 'match', width: 190, render: (_, script) => script.draft.kind === 'sandbox' ? <><Tag>独立 Node.js</Tag><div className="small muted">{script.draft.sandbox?.mode === 'service' ? '常驻服务' : '一次性计算'}</div></> : <Space size={[0, 4]} wrap>{script.draft.match.map((domain) => <Tag key={domain}>{domain}</Tag>)}</Space> },
      { title: '来源 / 配置', key: 'origin', width: 155, render: (_, script) => <><Tag color={script.origin === 'agent' ? 'green' : 'default'}>{ORIGIN[script.origin]}</Tag><div className="muted small">{script.draft.variables.length} 个变量 · {script.draft.dependencies.length} 个依赖 · {script.draft.sandbox?.mode === 'service' ? '初始化 ' : ''}{script.draft.timeout}s</div></> },
      { title: '创建 / 修改时间', key: 'timestamps', width: 185, render: (_, script) => <div className="small script-timestamps"><div title="创建时间">创建：{new Date(script.createdAt).toLocaleString('zh-CN')}</div><div title="修改时间">修改：{new Date(script.updatedAt).toLocaleString('zh-CN')}</div></div> },
      { title: '状态', key: 'status', width: 150, render: (_, script) => script.draft.kind === 'injection' ? <div><span className="muted small">{references(script.id).length} 个网站引用</span>{snapshot.runtimes.flatMap((runtime) => (runtime.injections || []).filter((item) => item.scriptId === script.id).map((item) => <div key={runtime.siteId}><Tag color={item.phase === 'disabled' ? 'red' : 'green'}>{item.phase === 'active' ? '已生效' : item.phase === 'disabled' ? '故障停用' : '初始化'}</Tag>{runtime.injectionsPending && <Tag color="orange">待重启</Tag>}</div>))}</div> : snapshot.scriptRuns.some((run) => run.scriptId === script.id) ? <Tag color="processing">{scriptRunLabel({ kind: script.draft.kind, status: 'running', phase: snapshot.scriptRuns.find((run) => run.scriptId === script.id)?.phase })}</Tag> : <span className="muted">可复用</span> },
      { title: '操作', key: 'actions', width: 210, render: (_, script) => {
        const active = snapshot.scriptRuns.some((run) => run.scriptId === script.id); return <Space size={2} wrap>
          {script.draft.kind !== 'injection' ? script.draft.kind === 'sandbox' && active ? <Button type="link" size="small" danger onClick={() => { const run = snapshot.scriptRuns.find((item) => item.scriptId === script.id); if (run) void command({ type: 'script.cancel', id: run.id }) }}>停止</Button> : <Button type="link" size="small" onClick={() => void open(script.id, 'run')}>{script.draft.sandbox?.mode === 'service' ? '启动' : '运行'}</Button> : <Tooltip title={references(script.id).map((site) => site.name).join('、') || '请到页面管理中绑定并启动网站'}><span className="small muted">网站注入</span></Tooltip>}
          <Button type="link" size="small" onClick={() => setLogs({ id: script.id, name: script.draft.name })}>日志</Button>
          <Button type="link" size="small" disabled={active} onClick={() => void open(script.id, 'edit')}>编辑</Button>
          <Button type="link" size="small" onClick={() => void command({ type: 'script.export', id: script.id })}>导出</Button>
          <Tooltip title={references(script.id).length ? `请先解绑并停止：${references(script.id).map((site) => site.name).join('、')}` : ''}><Button type="link" size="small" danger disabled={active || references(script.id).length > 0} onClick={() => void command({ type: 'script.delete', id: script.id })}>删除</Button></Tooltip>
        </Space>
      } }
    ]} /></section>
    {editor && <ScriptEditor script={editor.script} kind={editor.kind} close={() => setEditor(undefined)} />}
    {running && <ScriptRunForm script={running} close={() => setRunning(undefined)} started={() => { setLogs({ id: running.id, name: running.draft.name }); setRunning(undefined) }} />}
    {logs && <ScriptLogs id={logs.id} name={logs.name} close={() => setLogs(undefined)} />}
  </>
}
