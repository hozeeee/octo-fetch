import type { ProxyCredentials } from '../../../../shared/browser-options'
import type { InjectionBinding } from '../../../../shared/injections'
import type { RuntimeStatus, Site, SiteDraft } from '../../../../shared/model'
import type { ScriptSummary, ScriptValues } from '../../../../shared/scripts'
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, EditOutlined, MoreOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons'
import { Alert, Button, Checkbox, Dropdown, Empty, Form, Input, InputNumber, Modal, Select, Space, Table, Tag } from 'antd'
import { useState } from 'react'
import { z } from 'zod'
import { browserOptionsSchema, browserOptionsSummary, proxyCredentialsSchema } from '../../../../shared/browser-options'
import { siteDraftSchema } from '../../../../shared/model'
import { coerceVariables } from '../../../../shared/scripts'
import { useCommand, useDesktop } from '../../store'
import { BrowserOptionsForm } from './BrowserOptionsForm'
import { CookieEditor } from './CookieEditor'

function bindingValues(script?: ScriptSummary, supplied: ScriptValues = {}): ScriptValues {
  return Object.fromEntries((script?.draft.variables || []).flatMap((variable) => {
    const value = supplied[variable.key] ?? variable.default
    return value === undefined ? [] : [[variable.key, variable.kind === 'boolean' ? String(value) : value]]
  }))
}

export function Status({ status = 'stopped' }: { status?: RuntimeStatus }) {
  const labels = { stopped: '未运行', starting: '启动中', running: '运行中', stopping: '停止中', error: '异常' }
  return <span className={`status status-${status}`}><i />{labels[status]}</span>
}
export function SiteAvatar({ site }: { site: Site }) {
  return <span className="site-avatar">{site.name.slice(0, 1).toUpperCase()}</span>
}
export function SiteForm({ site, close }: { site?: Site; close(): void }) {
  const [form] = Form.useForm<SiteDraft>()
  const [busy, setBusy] = useState(false)
  const command = useCommand()
  const snapshot = useDesktop((state) => state.snapshot)!
  const scripts = snapshot.scripts.filter((script) => script.draft.kind === 'injection')
  const [error, setError] = useState('')
  const [options, setOptions] = useState(() => site?.browserOptions ?? browserOptionsSchema.parse({}))
  const [credentials, setCredentials] = useState<ProxyCredentials | null | undefined>()
  const [metadataError, setMetadataError] = useState('')
  return <Modal open width={900} styles={{ body: { maxHeight: '70vh', overflowY: 'auto', paddingRight: 12 } }} title={site ? '编辑页面配置' : '添加网站'} onCancel={close} onOk={() => form.submit()} confirmLoading={busy} okText={site ? '保存配置' : '添加网站'} cancelText="取消" destroyOnHidden>
    <p className="muted">每条配置都拥有独立浏览器和登录态，可为同一网站创建多个账号。</p>
    {error && <Alert type="error" showIcon title={error} className="spaced" />}
    <Form form={form} layout="vertical" initialValues={site ? { name: site.name, url: site.url, captureEnabled: site.captureEnabled, injections: site.injections.map((item) => ({ ...item, values: bindingValues(scripts.find((script) => script.id === item.scriptId), item.values) })) } : { name: '', url: 'https://', injections: [] }} onFinish={async (draft) => {
      setBusy(true); setError('')
      try {
        const injections = (draft.injections || []).map((binding) => {
          const script = scripts.find((script) => script.id === binding.scriptId)
          if (!script) throw new Error('请选择有效的注入脚本，或移除已失效的绑定')
          const supplied = Object.fromEntries(Object.entries(binding.values || {}).filter(([, value]) => value !== undefined && value !== null)) as ScriptValues
          return { scriptId: binding.scriptId, enabled: binding.enabled ?? true, values: coerceVariables(script.draft.variables, supplied) }
        })
        if (metadataError) throw new Error(metadataError)
        const browserOptions = browserOptionsSchema.parse(options)
        const proxyCredentials = credentials ? proxyCredentialsSchema.parse(credentials) : credentials
        if (await command({ type: 'site.save', id: site?.id, draft: { name: draft.name, url: draft.url, injections, browserOptions, captureEnabled: draft.captureEnabled ?? false }, proxyCredentials })) close()
      } catch (error) { setError(error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；') : error instanceof Error ? error.message : '配置无效') } finally { setBusy(false) }
    }}>
      <Form.Item label="名称" name="name" rules={[{ required: true, whitespace: true, message: '请输入名称' }, { max: 80, message: '名称不能超过 80 个字符' }]}><Input placeholder="例如：淘宝 · 主账号" autoFocus /></Form.Item>
      <Form.Item label="网站地址" name="url" rules={[{ validator: (_, value) => siteDraftSchema.shape.url.safeParse(value).success ? Promise.resolve() : Promise.reject(new Error('请输入完整的 HTTP / HTTPS 网址')) }]}><Input placeholder="https://www.taobao.com" /></Form.Item>
      <BrowserOptionsForm value={options} onChange={setOptions} version={snapshot.info.browserVersion} savedCredentials={Boolean(site?.proxyCredentialId)} credentials={credentials} onCredentials={setCredentials} onInvalid={setMetadataError} />
      <Form.Item name="captureEnabled" valuePropName="checked" extra="先在“抓包调试”启动代理；接入开关修改需重启网站。原代理和绕过列表不变。"><Checkbox>接入抓包调试</Checkbox></Form.Item>
      <div className="script-section-title"><strong>注入脚本</strong><span className="small muted">按顺序初始化 · 参数仅用于此网站</span></div>
      <Form.List name="injections">{(fields, { add, remove, move }) => <>
        {fields.map(({ key, name, ...rest }) => <div key={key} className="injection-binding">
          <div className="injection-binding-heading">
            <Form.Item {...rest} name={[name, 'scriptId']} label={`注入脚本 ${name + 1}`} rules={[{ required: true, message: '请选择注入脚本' }]}>
              <Select placeholder="选择注入脚本" options={scripts.map((script) => ({ value: script.id, label: script.draft.name, disabled: (form.getFieldValue('injections') as InjectionBinding[] || []).some((binding, index) => index !== name && binding.scriptId === script.id) }))} onChange={(id) => form.setFieldValue(['injections', name, 'values'], bindingValues(scripts.find((script) => script.id === id)))} />
            </Form.Item>
            <Form.Item {...rest} name={[name, 'enabled']} valuePropName="checked"><Checkbox>启用</Checkbox></Form.Item>
            <Space size={2}><Button aria-label="上移注入" icon={<ArrowUpOutlined />} disabled={name === 0} onClick={() => move(name, name - 1)} /><Button aria-label="下移注入" icon={<ArrowDownOutlined />} disabled={name === fields.length - 1} onClick={() => move(name, name + 1)} /><Button aria-label="移除注入" danger icon={<DeleteOutlined />} onClick={() => remove(name)} /></Space>
          </div>
          <Form.Item noStyle shouldUpdate>{() => {
            const script = scripts.find((script) => script.id === form.getFieldValue(['injections', name, 'scriptId']))
            return <>{script && <p className="small muted">适用域名：{script.draft.match.join('、')} · {script.draft.description || '暂无说明'}</p>}{script?.draft.variables.map((variable) => <Form.Item key={variable.key} name={[name, 'values', variable.key]} label={variable.label} rules={[{ required: variable.required, message: `请填写${variable.label}` }]} extra={`octo.vars.${variable.key}`}>
              {variable.kind === 'number' ? <InputNumber min={variable.min} max={variable.max} /> : variable.kind === 'boolean' ? <Select allowClear options={[{ value: 'true', label: '开启' }, { value: 'false', label: '关闭' }]} /> : variable.kind === 'enum' ? <Select allowClear options={variable.options?.map((value) => ({ value, label: value }))} /> : <Input maxLength={10000} />}
            </Form.Item>)}</>
          }}</Form.Item>
        </div>)}
        <Button icon={<PlusOutlined aria-hidden="true" />} disabled={fields.length >= scripts.length} onClick={() => add({ enabled: true, values: {} })}>添加注入</Button>
        {!scripts.length && <p className="muted small">先在「脚本能力」创建一个“注入”脚本。</p>}
      </>}</Form.List>
    </Form>
    <Alert className="spaced" type="info" showIcon title="保存不会刷新或关闭运行中的页面。网址、浏览器配置及注入改动均需停止后重新启动生效。仅绑定可信代码；不要在业务参数中填写凭据。" />
    <p className="small muted">网页弹窗接管前已发出的首次请求无法追溯应用配置；接管后导航使用当前运行配置，不重放登录或 POST 请求。</p>
  </Modal>
}
export function Sites({ add }: { add(): void }) {
  const snapshot = useDesktop((state) => state.snapshot)!
  const setFocus = useDesktop((state) => state.setFocus)
  const command = useCommand()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Site>()
  const [cookies, setCookies] = useState<Site>()
  const sites = snapshot.config.sites.filter((site) => `${site.name} ${site.url}`.toLowerCase().includes(search.toLowerCase()))
  return <>
    <div className="page-heading"><div><span className="eyebrow">PAGE MANAGER</span><h1>页面管理</h1><p>配置网站、隔离账号，让每个会话各得其所。</p></div><Button type="primary" icon={<PlusOutlined />} onClick={add}>添加网站</Button></div>
    <div className="table-panel"><div className="panel-toolbar"><strong>全部页面 <span className="count">{snapshot.config.sites.length}</span></strong><Input prefix={<SearchOutlined />} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称或网址" allowClear style={{ width: 270 }} /></div>
      <Table<Site> rowKey="id" dataSource={sites} pagination={{ pageSize: 10, hideOnSinglePage: true }} locale={{ emptyText: <Empty description="还没有匹配的网站配置" /> }} columns={[
        { title: '网站', render: (_, site) => <div className="site-cell"><SiteAvatar site={site} /><div><strong>{site.name}</strong><div className="muted url-text">{site.url}</div></div></div> },
        { title: '状态', width: 115, render: (_, site) => <Status status={snapshot.runtimes.find((item) => item.siteId === site.id)?.status} /> },
        { title: '浏览器', render: (_, site) => <div className="small">{browserOptionsSummary(site.browserOptions)}{snapshot.runtimes.find((item) => item.siteId === site.id)?.browserOptionsPending && <div><Tag color="orange">配置待重启生效</Tag></div>}</div> },
        { title: '抓包', width: 100, render: (_, site) => { const runtime = snapshot.runtimes.find((item) => item.siteId === site.id); return <Tag color={runtime?.captureError ? 'red' : runtime?.capturePending ? 'orange' : runtime?.captureActive ? 'green' : undefined}>{runtime?.captureError ? '出口失效' : runtime?.capturePending ? '待重启' : runtime?.captureActive ? '已生效' : site.captureEnabled ? '待启动' : '未接入'}</Tag> } },
        { title: '注入', width: 180, render: (_, site) => {
          const runtime = snapshot.runtimes.find((item) => item.siteId === site.id)
          return <div>{site.injections.length} 个绑定{runtime?.injections?.map((item) => <div key={item.scriptId} className="small"><Tag color={item.phase === 'active' ? 'green' : item.phase === 'disabled' ? 'red' : 'blue'}>{item.phase === 'active' ? '已生效' : item.phase === 'disabled' ? '故障停用' : '初始化'}</Tag>{item.name}</div>)}{runtime?.injectionsPending && <Tag color="orange">待重启生效</Tag>}</div>
        } },
        { title: '登录态', width: 220, render: (_, site) => <div><span>{site.cookieUpdatedAt ? `${site.cookieCount} 个 Cookie · 已保存` : '尚无 Cookie 快照'}</span><div className="muted small">{site.pendingCookies ? <Tag color="orange">有待应用修改</Tag> : site.cookieUpdatedAt ? new Date(site.cookieUpdatedAt).toLocaleString('zh-CN') : '浏览器目录自动持久化'}</div></div> },
        { title: '操作', width: 245, render: (_, site) => {
          const state = snapshot.runtimes.find((item) => item.siteId === site.id)
          const running = state?.status === 'running'
          const busy = state?.status === 'starting' || state?.status === 'stopping'
          return <Space><Button size="small" loading={busy} onClick={() => running ? setFocus(site.id) : void command({ type: 'browser.start', siteId: site.id })}>{running ? '打开' : '启动'}</Button><Button size="small" onClick={() => setCookies(site)}>Cookie</Button><Button size="small" icon={<EditOutlined />} aria-label="编辑配置" onClick={() => setEditing(site)} /><Dropdown trigger={['click']} menu={{ items: [
            { key: 'capture', label: '立即保存 Cookie 快照', disabled: !running },
            { key: 'stop', label: '停止网站', disabled: !running },
            { type: 'divider' }, { key: 'clear', label: '清除登录数据', danger: true }, { key: 'delete', label: '删除配置及数据', danger: true }
          ], onClick: ({ key }) => { void command({ type: key === 'capture' ? 'cookie.capture' : key === 'stop' ? 'browser.stop' : key === 'clear' ? 'site.clear' : 'site.delete', siteId: site.id }) } }}><Button size="small" icon={<MoreOutlined />} aria-label="更多操作" /></Dropdown></Space>
        } }
      ]} />
    </div>
    <div className="help-note">同一网站的不同配置互相隔离；配置内的多个标签共享登录态。</div>
    {editing && <SiteForm site={editing} close={() => setEditing(undefined)} />}
    {cookies && <CookieEditor site={cookies} close={() => setCookies(undefined)} />}
  </>
}
