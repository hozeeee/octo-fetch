import type { CaptureGrant } from '../../../../shared/capture'
import type { InstallResult, SavedScript, ScriptDraft, ScriptKind } from '../../../../shared/scripts'
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons'
import { Alert, Button, Checkbox, Form, Input, InputNumber, Modal, Select, Space, Spin } from 'antd'
import { lazy, Suspense, useState } from 'react'
import { INJECTION_TEMPLATE, MAX_SCRIPT_DEPENDENCIES, packageNameSchema, packageRangeSchema, REQUEST_TEMPLATE, SANDBOX_SERVICE_TEMPLATE, SANDBOX_SERVICE_VARIABLES, SANDBOX_TEMPLATE, SCRIPT_KINDS, SCRIPT_TEMPLATE, scriptDraftSchema } from '../../../../shared/scripts'
import { useCommand, useDesktop } from '../../store'

const CodeEditor = lazy(() => import('./CodeEditor'))
function SourceInput(props: { value?: string; onChange?(value: string): void; id?: string; kind?: ScriptKind }) {
  return <Suspense fallback={<div className="script-code-editor"><Spin /></div>}><CodeEditor {...props} /></Suspense>
}

export function ScriptEditor({ script, kind: initialKind = 'action', close }: { script?: SavedScript; kind?: ScriptKind; close(): void }) {
  const [form] = Form.useForm<ScriptDraft>()
  const command = useCommand()
  const snapshot = useDesktop((state) => state.snapshot)!
  const kind = Form.useWatch('kind', form) || script?.draft.kind || initialKind
  const mode = Form.useWatch(['sandbox', 'mode'], form) || 'once'
  const dependencies = Form.useWatch(['dependencies'], form) || []
  const templates = [SCRIPT_TEMPLATE, INJECTION_TEMPLATE, SANDBOX_TEMPLATE, SANDBOX_SERVICE_TEMPLATE]
  const referenced = script && (snapshot.config.sites.some((site) => site.injections.some((item) => item.scriptId === script.id)) || snapshot.runtimes.some((runtime) => runtime.injections?.some((item) => item.scriptId === script.id)))
  const [busy, setBusy] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installResult, setInstallResult] = useState<InstallResult>()
  const [error, setError] = useState('')
  const initial = script ? { ...script.draft, variables: script.draft.variables.map((variable) => ({ ...variable, default: variable.kind === 'boolean' && variable.default !== undefined ? String(variable.default) : variable.default })) } : { kind: initialKind, name: '', description: '', match: [], timeout: 60, variables: [], dependencies: [], sandbox: initialKind === 'sandbox' ? { mode: 'once' } : undefined, source: initialKind === 'sandbox' ? SANDBOX_TEMPLATE : initialKind === 'injection' ? INJECTION_TEMPLATE : SCRIPT_TEMPLATE }
  const install = async () => {
    if (!script) return
    const current = dependencies.map(({ name, version }: { name?: string; version?: string }) => ({ name: name?.trim(), version: version?.trim() || 'latest' }))
    if (JSON.stringify(current) !== JSON.stringify(script.draft.dependencies)) {
      setError('依赖声明已修改，请先保存脚本，再重新打开安装。')
      return
    }
    setInstalling(true); setError(''); setInstallResult(undefined)
    try {
      const reply = await window.octo.installDependencies(script.id)
      if (!reply.ok) setError(reply.error); else setInstallResult(reply.data)
    } catch { setError('无法安装依赖') } finally { setInstalling(false) }
  }
  return <Modal open title={script ? '编辑脚本能力' : '新建脚本能力'} width={980} onCancel={close} okText="保存脚本" cancelText="取消" confirmLoading={busy} okButtonProps={{ disabled: installing }} onOk={() => form.submit()} maskClosable={false}>
    <Alert className="spaced" showIcon type="warning" title="仅保存和运行可信来源的代码" description={kind === 'sandbox' ? '沙箱是独立 Node.js 进程，并非安全隔离。脚本可访问本机文件、网络和进程；停止不能撤销副作用。源码、变量和日志明文保存，请勿输入凭据。' : '完整 Node 模式下，脚本及第三方依赖既可使用网站登录态，也可访问本机文件、网络和进程。Worker 不是安全沙箱，请勿运行不可信代码或写入凭据。'} />
    {error && <Alert className="spaced" type="error" showIcon title={error} />}
    {script && <div className="script-timestamps">创建时间：{new Date(script.createdAt).toLocaleString('zh-CN')} · 修改时间：{new Date(script.updatedAt).toLocaleString('zh-CN')}</div>}
    <Form.Item label="抓包访问（仅本机授权）" extra={script ? `${snapshot.config.capture.settings.allowScripts ? '脚本总开关已开启' : '请在抓包调试中开启脚本总开关'}；${script.draft.kind === 'sandbox' ? '沙箱可读取全部来源' : '行动和注入仅可读取运行网站'}。授权立即生效，不随导出或复制传播。` : '先保存脚本，再单独授予抓包权限；新脚本默认无权限。'}>
      <Select aria-label="抓包访问授权" disabled={!script || busy || kind !== script.draft.kind} value={script ? snapshot.config.capture.grants[script.id] || 'none' : 'none'} options={[{ value: 'none', label: '不允许' }, { value: 'read', label: '读取抓包' }, { value: 'control', label: '读取及启停代理' }]} onChange={async (grant: CaptureGrant) => {
        if (!script) return
        setBusy(true)
        try { await command({ type: 'capture.grant', scriptId: script.id, grant }) } finally { setBusy(false) }
      }} />
    </Form.Item>
    {kind === 'injection' && <Alert className="spaced" type="info" showIcon title="在页面管理中绑定注入；配置和源码修改在网站重启后生效。" />}
    <Form form={form} layout="vertical" initialValues={initial} onFinish={async (values) => {
      if (busy || installing) return
      const variables = values.variables.map((variable) => Object.fromEntries(Object.entries(variable).filter(([, value]) => value !== null && value !== undefined)))
      const parsed = scriptDraftSchema.safeParse({ ...values, variables })
      if (!parsed.success) { setError(parsed.error.issues.map((issue) => `${issue.path.join('.')}：${issue.message}`).join('；')); return }
      setBusy(true); setError('')
      try { if (await command({ type: 'script.save', id: script?.id, draft: parsed.data })) close() } finally { setBusy(false) }
    }}>
      <Form.Item name="kind" label="脚本类型"><Select disabled={Boolean(referenced)} options={Object.entries(SCRIPT_KINDS).map(([value, label]) => ({ value, label }))} onChange={(next: ScriptKind) => {
        const source = form.getFieldValue('source')
        if (templates.includes(source)) form.setFieldValue('source', next === 'sandbox' ? SANDBOX_TEMPLATE : next === 'injection' ? INJECTION_TEMPLATE : SCRIPT_TEMPLATE)
        form.setFieldValue('sandbox', next === 'sandbox' ? { mode: 'once' } : undefined)
        if (next === 'sandbox') form.setFieldValue('match', [])
      }} /></Form.Item>
      <div className="script-editor-grid">
        <Form.Item name="name" label="脚本名称" rules={[{ required: true, whitespace: true, message: '请输入名称' }]}><Input maxLength={80} placeholder="例如：商品搜索与结果采集" /></Form.Item>
        <Form.Item name="timeout" label={kind === 'injection' || (kind === 'sandbox' && mode === 'service') ? '初始化超时（秒）' : '执行超时（秒）'} rules={[{ required: true }]}><InputNumber min={1} max={600} precision={0} style={{ width: '100%' }} /></Form.Item>
      </div>
      <Form.Item name="description" label="能力说明"><Input.TextArea rows={2} maxLength={2000} placeholder="描述用途、登录要求和结果结构，方便 agent 检索与复用" /></Form.Item>
      {kind === 'sandbox' ? <Form.Item name={['sandbox', 'mode']} label="运行模式" extra={`Node.js ${snapshot.info.nodeVersion || '内置版本'} · 常驻仅限制初始化时间，服务就绪后返回，关闭日志不会停止运行。`}><Select options={[{ value: 'once', label: '一次性计算' }, { value: 'service', label: '常驻服务' }]} onChange={(next) => {
        if (templates.includes(form.getFieldValue('source'))) form.setFieldValue('source', next === 'service' ? SANDBOX_SERVICE_TEMPLATE : SANDBOX_TEMPLATE)
        if (next === 'service' && !form.getFieldValue('variables')?.length) form.setFieldValue('variables', SANDBOX_SERVICE_VARIABLES.map((item) => ({ ...item })))
      }} /></Form.Item> : <Form.Item name="match" label="适用域名" extra="*.taobao.com 匹配根域与子域；taobao.com 只精确匹配。不含协议、端口、路径，输入后按回车。" rules={[{ required: true, message: '至少添加一个域名' }]}><Select mode="tags" tokenSeparators={[',', '，', ' ']} placeholder="例如：*.taobao.com" /></Form.Item>}
      <div className="script-section-title"><strong>第三方依赖</strong><span className="muted small">保存声明后需手动安装到该脚本的独立 node_modules；安装成功前不能启动，且不会执行 lifecycle scripts。</span></div>
      <Form.List name="dependencies">{(fields, { add, remove }) => <>
        {fields.map(({ key, name, ...rest }) => <Space key={key} align="start" className="script-variable">
          <Form.Item {...rest} name={[name, 'name']} label="包名" rules={[{ required: true }, { validator: async (_, value) => { const parsed = packageNameSchema.safeParse(value); if (!parsed.success) throw new Error(parsed.error.issues[0].message) } }]}><Input placeholder="lodash 或 @scope/pkg" /></Form.Item>
          <Form.Item {...rest} name={[name, 'version']} label="版本" rules={[{ validator: async (_, value) => { const parsed = packageRangeSchema.safeParse(value || 'latest'); if (!parsed.success) throw new Error(parsed.error.issues[0].message) } }]}><Input placeholder="latest 或 ^4.17.21" /></Form.Item>
          <Button type="text" danger aria-label="删除依赖" icon={<MinusCircleOutlined />} onClick={() => remove(name)} />
        </Space>)}
        <Space wrap><Button icon={<PlusOutlined aria-hidden="true" />} onClick={() => add({ name: '', version: 'latest' })} disabled={fields.length >= MAX_SCRIPT_DEPENDENCIES}>添加依赖</Button><Button loading={installing} disabled={!script || busy} onClick={() => void install()}>安装已保存依赖</Button><span className="small muted">{script ? `使用 ${snapshot.config.settings.sandboxRegistry}` : '先保存脚本后再安装'}</span></Space>
      </>}</Form.List>
      {installResult && <Alert className="spaced" showIcon type={installResult.ok ? 'success' : 'error'} title={installResult.ok ? '依赖安装完成' : installResult.error || '依赖安装失败'} description={installResult.logs ? <pre className="script-guide">{installResult.logs}</pre> : undefined} />}
      <div className="script-section-title"><strong>运行变量</strong><span className="muted small">通过 octo.vars.变量名 读取，运行前可调整参数。</span></div>
      <Form.List name="variables">{(fields, { add, remove }) => <>
        {fields.map(({ key, name, ...rest }) => <div className="script-variable" key={key}>
          <div className="script-variable-grid">
            <Form.Item {...rest} name={[name, 'key']} label="变量名" rules={[{ required: true }]}><Input placeholder="searchText" /></Form.Item>
            <Form.Item {...rest} name={[name, 'label']} label="显示名称" rules={[{ required: true }]}><Input placeholder="搜索内容" /></Form.Item>
            <Form.Item {...rest} name={[name, 'kind']} label="类型"><Select options={[{ value: 'text', label: '文本' }, { value: 'number', label: '数字' }, { value: 'boolean', label: '开关' }, { value: 'enum', label: '枚举' }]} onChange={() => { form.setFieldValue(['variables', name, 'default'], undefined); form.setFieldValue(['variables', name, 'options'], undefined) }} /></Form.Item>
            <Form.Item {...rest} name={[name, 'required']} label="必填" valuePropName="checked"><Checkbox /></Form.Item>
            <Button type="text" danger aria-label="删除变量" icon={<MinusCircleOutlined />} onClick={() => remove(name)} />
          </div>
          <Form.Item noStyle shouldUpdate>{() => {
            const kind = form.getFieldValue(['variables', name, 'kind'])
            const options = form.getFieldValue(['variables', name, 'options']) as string[] | undefined
            return <Space align="start" wrap>
              {kind === 'enum' && <Form.Item {...rest} name={[name, 'options']} label="候选值"><Select mode="tags" tokenSeparators={[',', '，']} style={{ minWidth: 220 }} placeholder="输入候选值后按回车" /></Form.Item>}
              <Form.Item {...rest} name={[name, 'default']} label="默认值">
                {kind === 'boolean' ? <Select allowClear style={{ width: 160 }} options={[{ value: 'true', label: '开启' }, { value: 'false', label: '关闭' }]} /> : kind === 'number' ? <InputNumber /> : kind === 'enum' ? <Select allowClear style={{ minWidth: 160 }} options={options?.map((value) => ({ value, label: value }))} /> : <Input maxLength={10000} placeholder="可留空" />}
              </Form.Item>
              {kind === 'number' && <><Form.Item {...rest} name={[name, 'min']} label="最小值"><InputNumber /></Form.Item><Form.Item {...rest} name={[name, 'max']} label="最大值"><InputNumber /></Form.Item></>}
            </Space>
          }}</Form.Item>
        </div>)}
        <Button icon={<PlusOutlined aria-hidden="true" />} onClick={() => add({ key: '', label: '', kind: 'text', required: false })} disabled={fields.length >= 30}>添加变量</Button>
      </>}</Form.List>
      {kind === 'injection' && <details className="spaced"><summary>请求改写示例（可添加到下方源码）</summary><pre className="script-guide">{REQUEST_TEMPLATE}</pre></details>}
      <Form.Item name="source" label="JavaScript 源码（.js）" className="spaced" extra={kind === 'sandbox' ? '异步函数体，可 await / return；支持 require 与动态 import 内置模块或已安装依赖，提供 octo 和 Node.js 全局，无 page/browser。用 octo.onDispose 清理资源。' : kind === 'injection' ? '支持 require 与动态 import 已安装依赖；在初始化函数体中注册拦截器，并用 octo.onDispose 清理。' : '异步函数体，可 await / return；支持 require 与动态 import 已安装依赖，提供 page、browser、octo 和 Node.js 能力。'} rules={[{ required: true, whitespace: true }, { max: 200000, message: '源码不能超过 200000 字符' }]}><SourceInput kind={kind} /></Form.Item>
    </Form>
  </Modal>
}
