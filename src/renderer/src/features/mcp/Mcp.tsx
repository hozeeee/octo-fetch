import type { McpLevel, McpToken, TokenDraft } from '../../../../shared/model'
import { CopyOutlined, EditOutlined, MoreOutlined, PlusOutlined } from '@ant-design/icons'
import { Alert, App, Button, Dropdown, Empty, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { MAX_TOKENS, MCP_LEVEL_LABELS, MCP_LEVELS } from '../../../../shared/model'
import { useCommand, useDesktop } from '../../store'

const LEVEL_COLORS: Record<McpLevel, string> = { read: 'blue', operate: 'gold', full: 'volcano' }
const LEVEL_HINTS: Record<McpLevel, string> = {
  read: '可查看页面、截图、脚本源码与运行日志，不能保存或运行脚本。',
  operate: '可启动或停止网站、开关标签、导航翻页、保存 Cookie 快照；启动会加载预先绑定的可信注入。',
  full: '可点击输入、读写 Cookie、修改配置，并保存/运行可信本机 JavaScript 脚本；请只给信任的接入端。'
}
const levelOptions = MCP_LEVELS.map((level) => ({ value: level, label: MCP_LEVEL_LABELS[level] }))
const clientConfig = (endpoint: string, secret: string): string =>
  JSON.stringify({ mcpServers: { 'octo-fetch': { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2)

// 明文令牌不进状态快照，生成、重置和主动查看时都要现取一次。
function useSecret(): (id: string) => Promise<string | undefined> {
  const { message } = App.useApp()
  return async (id) => {
    try {
      const reply = await window.octo.secret({ type: 'reveal', id })
      if (reply.ok) return reply.data.secret
      void message.error({ content: reply.error, key: 'secret-error' })
    } catch { void message.error({ content: '桌面服务暂时不可用', key: 'secret-error' }) }
    return undefined
  }
}
function SecretView({ alias, secret, endpoint, close }: { alias: string; secret: string; endpoint: string; close(): void }) {
  return <Modal open width={640} title={`接入令牌 · ${alias}`} onCancel={close} destroyOnHidden footer={<Button type="primary" onClick={close}>完成</Button>}>
    <p className="muted">把令牌粘贴到接入端的 Authorization 请求头。令牌通过系统钥匙串加密保存在本机，之后可以随时重新复制。</p>
    <Typography.Paragraph className="token-secret" copyable={{ text: secret, tooltips: ['复制令牌', '已复制'] }}>{secret}</Typography.Paragraph>
    <p className="small muted">多数客户端支持下面这段配置，直接整段复制即可：</p>
    <Typography.Paragraph className="token-secret" copyable={{ text: clientConfig(endpoint, secret), tooltips: ['复制配置', '已复制'] }}><pre className="token-config">{clientConfig(endpoint, secret)}</pre></Typography.Paragraph>
    <Alert type="warning" showIcon title="持有令牌即可操作本机浏览器中的登录态，请勿贴到聊天记录或代码仓库里。" />
  </Modal>
}
function TokenForm({ token, close, reveal }: { token?: McpToken; close(): void; reveal?(id: string, alias: string): void }) {
  const [form] = Form.useForm<TokenDraft>()
  const [busy, setBusy] = useState(false)
  const command = useCommand()
  const { message } = App.useApp()
  const level = Form.useWatch('level', form)
  return <Modal open title={token ? '编辑接入身份' : '新建接入身份'} onCancel={close} onOk={() => form.submit()} confirmLoading={busy} okText={token ? '保存身份' : '生成令牌'} cancelText="取消" destroyOnHidden>
    <p className="muted">每个接入端建议单独建一个身份，这样能分别限权、暂停和查看调用量。</p>
    <Form form={form} layout="vertical" initialValues={token ? { alias: token.alias, level: token.level } : { alias: '', level: 'read' }} onFinish={async (draft) => {
      setBusy(true)
      try {
        if (token) { if (await command({ type: 'token.save', id: token.id, draft })) close() } else {
          const reply = await window.octo.secret({ type: 'create', draft })
          if (reply.ok) { reveal?.(reply.data.id, draft.alias); close() } else {
            void message.error(reply.error)
          }
        }
      } catch { void message.error('桌面服务暂时不可用') } finally { setBusy(false) }
    }}>
      <Form.Item label="别名" name="alias" rules={[{ required: true, whitespace: true, message: '请输入别名' }, { max: 40, message: '别名不能超过 40 个字符' }]}><Input placeholder="例如：Claude Desktop" autoFocus /></Form.Item>
      <Form.Item label="权限等级" name="level" rules={[{ required: true, message: '请选择权限等级' }]}><Select options={levelOptions} /></Form.Item>
    </Form>
    <Alert type="info" showIcon title={LEVEL_HINTS[level || 'read']} description="等级向下包含：三级身份可以调用一、二级的全部工具。" />
  </Modal>
}
function Service() {
  const snapshot = useDesktop((state) => state.snapshot)!
  const command = useCommand()
  const { message } = App.useApp()
  const settings = snapshot.config.mcp.settings
  const state = snapshot.mcp
  const [port, setPort] = useState(settings.port)
  const [busy, setBusy] = useState(false)
  useEffect(() => setPort(settings.port), [settings.port])
  const save = async (enabled: boolean, nextPort: number, hint: string) => {
    setBusy(true)
    if (await command({ type: 'mcp.save', settings: { enabled, port: nextPort } })) void message.success(hint)
    setBusy(false)
  }
  return <section className="settings-panel"><div className="panel-title"><h3>本机服务</h3><p>只监听 127.0.0.1，不对局域网开放；关闭开关即刻停止服务。</p></div>
    <div className="mcp-switch"><div><strong>启用 MCP 服务</strong><div className="muted small">{state.running ? '正在接受接入端请求' : settings.enabled ? '尚未监听成功' : '当前已关闭'}</div></div>
      <Space>{state.running ? <Tag color="green">运行中</Tag> : <Tag>未启动</Tag>}<Switch checked={settings.enabled} loading={busy} onChange={(checked) => void save(checked, port, checked ? 'MCP 服务已启用' : 'MCP 服务已停止')} /></Space>
    </div>
    <div className="mcp-port"><label>监听端口<InputNumber min={1024} max={65535} precision={0} value={port} disabled={state.running || busy} onChange={(value) => setPort(value ?? settings.port)} /></label>
      <Button loading={busy} disabled={state.running || port === settings.port} onClick={() => void save(settings.enabled, port, '端口已更新')}>保存端口</Button>
      {/* 端口被占时服务并未运行，这时候必须能直接换端口。 */}
      {state.running && <span className="muted small port-hint">运行中不能改端口，请先关闭服务</span>}
    </div>
    <div className="data-path">{state.endpoint}</div>
    <Typography.Text copyable={{ text: state.endpoint, tooltips: ['复制地址', '已复制'] }}>复制服务地址</Typography.Text>
    {state.error && <Alert type="error" showIcon title={state.error} className="spaced" />}
  </section>
}
export function Mcp() {
  const snapshot = useDesktop((state) => state.snapshot)!
  const command = useCommand()
  const { modal } = App.useApp()
  const read = useSecret()
  const [editing, setEditing] = useState<McpToken>()
  const [adding, setAdding] = useState(false)
  const [secret, setSecret] = useState<{ alias: string; secret: string }>()
  const tokens = snapshot.config.mcp.tokens
  const show = async (id: string, alias: string) => {
    const value = await read(id)
    if (value) setSecret({ alias, secret: value })
  }
  return <>
    <div className="page-heading"><div><span className="eyebrow">MCP SERVICE</span><h1>MCP 服务</h1><p>把本机浏览器里的登录态开放给 AI 客户端，按身份限权与计数。</p></div><Button type="primary" icon={<PlusOutlined />} disabled={tokens.length >= MAX_TOKENS} onClick={() => setAdding(true)}>新建接入身份</Button></div>
    <div className="settings-layout"><Service />
      <section className="settings-panel"><div className="panel-title"><h3>怎么接入</h3><p>接入端不需要安装任何东西，填地址和令牌即可。</p></div>
        <ol className="settings-steps"><li>启用服务并确认端口没被占用。</li><li>新建身份、选好等级，复制生成的令牌。</li><li>在客户端填写服务地址，并加上 <code>Authorization: Bearer 令牌</code>。</li><li>先让客户端调用 <code>list_sites</code>，拿到页面 ID 与运行状态。</li></ol>
        <Alert type="info" showIcon title="启动网站会加载预先绑定的可信注入。" description="三级身份可用 script_guide → list_scripts → save_script 保存行动或注入。行动通过 run_script 执行；注入通过 save_site 绑定，重启网站后生效；read_script_runs 查看日志。不提供读改服务设置与令牌的工具。脚本属于可信本机代码，并非安全沙箱，请仅向可信 Agent 授权。" />
        <p className="small muted">抓包仅向一级／二级开放非敏感状态 <code>capture_status</code>；<code>capture_requests</code>、<code>capture_detail</code>、<code>capture_start</code>、<code>capture_stop</code> 需三级身份，并先在抓包调试页开启“允许 MCP 访问抓包”。不提供 LAN、证书、上游或规则修改工具；有关联网站时不自动停止网站。</p>
        <p className="small muted">工具清单按身份等级裁剪：一级可读脚本与日志，二级可开关网站与导航，三级可生成、执行及删除脚本。保存后在「脚本能力」管理，可配置参数并导出迁移。</p>
      </section>
    </div>
    <div className="table-panel spaced"><div className="panel-toolbar"><strong>接入身份 <span className="count">{tokens.length}</span></strong><span className="muted small">最多 {MAX_TOKENS} 个</span></div>
      <Table<McpToken> rowKey="id" dataSource={tokens} pagination={{ pageSize: 8, hideOnSinglePage: true }} locale={{ emptyText: <Empty description="还没有接入身份，新建后即可分发令牌" /> }} columns={[
        { title: '身份', render: (_, token) => <div><strong>{token.alias}</strong><div className="muted url-text">{token.prefix}··· · {new Date(token.createdAt).toLocaleDateString('zh-CN')} 创建</div></div> },
        { title: '权限等级', width: 140, render: (_, token) => <Tag color={LEVEL_COLORS[token.level]}>{MCP_LEVEL_LABELS[token.level]}</Tag> },
        { title: '启用', width: 90, render: (_, token) => <Switch size="small" checked={token.enabled} aria-label="暂停或恢复此身份" onChange={(checked) => void command({ type: 'token.enable', id: token.id, enabled: checked })} /> },
        { title: '调用统计', width: 235, render: (_, token) => <div><span>{token.calls} 次调用</span>{Boolean(token.errors || token.denied) && <span className="muted small"> · 失败 {token.errors} · 拒绝 {token.denied}</span>}<div className="muted small">{token.lastUsedAt ? `${new Date(token.lastUsedAt).toLocaleString('zh-CN')}${token.lastTool ? ` · ${token.lastTool}` : ''}` : '尚未被调用'}</div></div> },
        { title: '操作', width: 215, render: (_, token) => <Space><Button size="small" icon={<CopyOutlined />} onClick={() => void show(token.id, token.alias)}>查看令牌</Button><Button size="small" icon={<EditOutlined />} aria-label="编辑身份" onClick={() => setEditing(token)} /><Dropdown trigger={['click']} menu={{ items: [
          { key: 'rotate', label: '重新生成令牌' }, { type: 'divider' }, { key: 'delete', label: '删除身份', danger: true }
        ], onClick: ({ key }) => {
          if (key === 'delete') { void command({ type: 'token.delete', id: token.id }); return }
          modal.confirm({ title: `重新生成“${token.alias}”的令牌？`, content: '旧令牌立即失效，需要在接入端重新粘贴；别名、等级和调用统计会保留。', okText: '重新生成', cancelText: '取消', onOk: async () => { if (await command({ type: 'token.rotate', id: token.id })) await show(token.id, token.alias) } })
        } }}><Button size="small" icon={<MoreOutlined />} aria-label="更多操作" /></Dropdown></Space> }
      ]} />
    </div>
    <div className="help-note">暂停身份后，该令牌的所有请求都会被拒绝并计入拒绝次数；删除身份会同时销毁本机保存的令牌明文。</div>
    {adding && <TokenForm close={() => setAdding(false)} reveal={(id, alias) => void show(id, alias)} />}
    {editing && <TokenForm token={editing} close={() => setEditing(undefined)} />}
    {secret && <SecretView alias={secret.alias} secret={secret.secret} endpoint={snapshot.mcp.endpoint} close={() => setSecret(undefined)} />}
  </>
}
