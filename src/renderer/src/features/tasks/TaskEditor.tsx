import type { ScriptVariable } from '../../../../shared/scripts'
import type { SavedTask, TaskDraft } from '../../../../shared/tasks'
import { ArrowDownOutlined, ArrowUpOutlined, MinusCircleOutlined, PlusOutlined } from '@ant-design/icons'
import { Alert, Button, Checkbox, Form, Input, InputNumber, Modal, Radio, Select, Space, Switch, Tag } from 'antd'
import { useMemo, useState } from 'react'
import { cronNext, validateCron } from '../../../../shared/cron'
import { MAX_TASK_STEPS, taskDraftSchema } from '../../../../shared/tasks'
import { useCommand, useDesktop } from '../../store'

// 任务表单里每个步骤变量的取值来源：沿用脚本默认、引用任务变量或填写自定义字面值。
type Source = { mode: 'default' | 'link' | 'value'; link?: string; value?: unknown }
type StepForm = { scriptId?: string; siteId?: string; optional?: boolean; sources?: Record<string, Source> }

// 依变量类型渲染取值控件；Form.Item 会向该控件注入 value / onChange。
function valueControl(variable: ScriptVariable) {
  if (variable.kind === 'number') return <InputNumber min={variable.min} max={variable.max} style={{ width: '100%' }} />
  if (variable.kind === 'boolean') return <Select allowClear options={[{ value: 'true', label: '开启' }, { value: 'false', label: '关闭' }]} />
  if (variable.kind === 'enum') return <Select allowClear options={variable.options?.map((value) => ({ value, label: value }))} />
  return <Input maxLength={10000} placeholder="自定义值" />
}
const asFormValue = (value: unknown) => (typeof value === 'boolean' ? String(value) : value)

export function TaskEditor({ task, close }: { task?: SavedTask; close(): void }) {
  const [form] = Form.useForm()
  const command = useCommand()
  const snapshot = useDesktop((state) => state.snapshot)!
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const actionScripts = useMemo(() => snapshot.scripts.filter((script) => script.draft.kind === 'action'), [snapshot.scripts])
  const sites = snapshot.config.sites
  const scriptVars = (scriptId?: string): ScriptVariable[] => (scriptId ? actionScripts.find((script) => script.id === scriptId)?.draft.variables ?? [] : [])
  const initial = useMemo(() => {
    if (!task) return { name: '', description: '', variables: [], values: {}, steps: [{ optional: false, sources: {} }], onError: 'stop', schedule: { enabled: false, cron: '' } }
    return {
      ...task.draft,
      variables: task.draft.variables.map((variable) => ({ ...variable, default: asFormValue(variable.default) })),
      values: Object.fromEntries(Object.entries(task.draft.values).map(([key, value]) => [key, asFormValue(value)])),
      steps: task.draft.steps.map((step) => {
        const sources: Record<string, Source> = {}
        for (const [key, link] of Object.entries(step.links)) sources[key] = { mode: 'link', link }
        for (const [key, value] of Object.entries(step.values)) sources[key] = { mode: 'value', value: asFormValue(value) }
        return { scriptId: step.scriptId, siteId: step.siteId, optional: step.optional, sources }
      })
    }
  }, [task])

  const submit = async (values: Record<string, unknown>) => {
    if (busy) return
    const variables = (values.variables as Record<string, unknown>[] || []).map((variable) => Object.fromEntries(Object.entries(variable).filter(([, value]) => value !== null && value !== undefined)))
    const taskValues = Object.fromEntries(Object.entries((values.values as Record<string, unknown>) || {}).filter(([, value]) => value !== undefined && value !== null && value !== ''))
    const steps = (values.steps as StepForm[] || []).map((step) => {
      const links: Record<string, string> = {}
      const stepValues: Record<string, unknown> = {}
      for (const [key, source] of Object.entries(step.sources || {})) {
        if (source?.mode === 'link' && source.link) links[key] = source.link
        else if (source?.mode === 'value' && source.value !== undefined && source.value !== null && source.value !== '') stepValues[key] = source.value
      }
      return { scriptId: step.scriptId, siteId: step.siteId, optional: Boolean(step.optional), links, values: stepValues }
    })
    const parsed = taskDraftSchema.safeParse({ name: values.name, description: values.description, variables, values: taskValues, steps, onError: values.onError, schedule: values.schedule })
    if (!parsed.success) { setError(parsed.error.issues.map((issue) => `${issue.path.join('.')}：${issue.message}`).join('；')); return }
    setBusy(true); setError('')
    try { if (await command({ type: 'task.save', id: task?.id, draft: parsed.data as TaskDraft })) close() } finally { setBusy(false) }
  }

  return <Modal open title={task ? '编辑任务' : '新建任务'} width={1040} onCancel={close} okText="保存任务" cancelText="取消" confirmLoading={busy} onOk={() => form.submit()} maskClosable={false}>
    <Alert className="spaced" showIcon type="info" title="任务把多个行动脚本串行编排" description="每个步骤固定绑定一个行动脚本与目标网站；运行时须目标网站已启动且标签匹配域名。步骤脚本按“引用任务变量 > 步骤自定义值 > 脚本默认值”组装参数。" />
    {error && <Alert className="spaced" type="error" showIcon title={error} />}
    {task && <div className="script-timestamps">创建时间：{new Date(task.createdAt).toLocaleString('zh-CN')} · 修改时间：{new Date(task.updatedAt).toLocaleString('zh-CN')}</div>}
    <Form form={form} layout="vertical" initialValues={initial} onFinish={submit}>
      <div className="script-editor-grid">
        <Form.Item name="name" label="任务名称" rules={[{ required: true, whitespace: true, message: '请输入名称' }]}><Input maxLength={80} placeholder="例如：每日商品价格采集" /></Form.Item>
        <Form.Item name="onError" label="出错处理"><Radio.Group optionType="button" options={[{ value: 'stop', label: '遇错即停' }, { value: 'continue', label: '遇错继续' }]} /></Form.Item>
      </div>
      <Form.Item name="description" label="任务说明"><Input.TextArea rows={2} maxLength={2000} placeholder="描述用途与前置条件，便于复用与检索" /></Form.Item>

      <div className="script-section-title"><strong>任务变量</strong><span className="muted small">在步骤中被脚本变量引用，一处配置多步复用。</span></div>
      <Form.List name="variables">{(fields, { add, remove }) => <>
        {fields.map(({ key, name, ...rest }) => <div className="script-variable" key={key}>
          <div className="script-variable-grid">
            <Form.Item {...rest} name={[name, 'key']} label="变量名" rules={[{ required: true }]}><Input placeholder="keyword" /></Form.Item>
            <Form.Item {...rest} name={[name, 'label']} label="显示名称" rules={[{ required: true }]}><Input placeholder="关键词" /></Form.Item>
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
        <Button icon={<PlusOutlined aria-hidden="true" />} onClick={() => add({ key: '', label: '', kind: 'text', required: false })} disabled={fields.length >= 30}>添加任务变量</Button>
      </>}</Form.List>

      <Form.Item noStyle shouldUpdate>{() => {
        const variables = (form.getFieldValue('variables') as ScriptVariable[] || []).filter((variable) => variable?.key)
        if (!variables.length) return null
        return <><div className="script-section-title"><strong>任务变量取值</strong><span className="muted small">未填写则使用变量默认值。</span></div>
          <Space wrap align="start">{variables.map((variable) => <Form.Item key={variable.key} name={['values', variable.key]} label={variable.label || variable.key}>{valueControl(variable)}</Form.Item>)}</Space></>
      }}</Form.Item>

      <div className="script-section-title"><strong>执行步骤</strong><span className="muted small">按顺序串行执行；每步真正跑一次行动运行。</span></div>
      <Form.List name="steps">{(fields, { add, remove, move }) => <>
        {fields.map(({ key, name, ...rest }, order) => <div className="task-step" key={key}>
          <div className="task-step-head"><Tag color="blue">步骤 {order + 1}</Tag><Space size={2}>
            <Button type="text" size="small" aria-label="上移" icon={<ArrowUpOutlined />} disabled={order === 0} onClick={() => move(order, order - 1)} />
            <Button type="text" size="small" aria-label="下移" icon={<ArrowDownOutlined />} disabled={order === fields.length - 1} onClick={() => move(order, order + 1)} />
            <Form.Item {...rest} name={[name, 'optional']} valuePropName="checked" noStyle><Checkbox>允许失败</Checkbox></Form.Item>
            <Button type="text" danger size="small" aria-label="删除步骤" icon={<MinusCircleOutlined />} onClick={() => remove(name)} />
          </Space></div>
          <div className="script-editor-grid">
            <Form.Item {...rest} name={[name, 'scriptId']} label="行动脚本" rules={[{ required: true, message: '请选择行动脚本' }]}><Select placeholder="选择行动脚本" options={actionScripts.map((script) => ({ value: script.id, label: script.draft.name }))} onChange={() => form.setFieldValue(['steps', name, 'sources'], {})} showSearch optionFilterProp="label" /></Form.Item>
            <Form.Item {...rest} name={[name, 'siteId']} label="目标网站" rules={[{ required: true, message: '请选择网站' }]}><Select placeholder="选择目标网站" options={sites.map((site) => ({ value: site.id, label: site.name }))} showSearch optionFilterProp="label" /></Form.Item>
          </div>
          <Form.Item noStyle shouldUpdate>{() => {
            const scriptId = form.getFieldValue(['steps', name, 'scriptId']) as string | undefined
            const vars = scriptVars(scriptId)
            const taskVars = (form.getFieldValue('variables') as ScriptVariable[] || []).filter((variable) => variable?.key)
            if (!vars.length) return scriptId ? <span className="muted small">该脚本无可配置变量。</span> : null
            return <div className="task-step-vars">{vars.map((variable) => <div className="task-step-var" key={variable.key}>
              <span className="task-step-var-name">{variable.label}<code className="small muted"> {variable.key}</code></span>
              <Form.Item {...rest} name={[name, 'sources', variable.key, 'mode']} noStyle initialValue="default"><Select style={{ width: 130 }} options={[{ value: 'default', label: '脚本默认' }, { value: 'link', label: '引用任务变量', disabled: !taskVars.length }, { value: 'value', label: '自定义值' }]} /></Form.Item>
              <Form.Item noStyle shouldUpdate>{() => {
                const mode = form.getFieldValue(['steps', name, 'sources', variable.key, 'mode']) || 'default'
                if (mode === 'link') return <Form.Item {...rest} name={[name, 'sources', variable.key, 'link']} noStyle rules={[{ required: true, message: '请选择任务变量' }]}><Select style={{ minWidth: 180 }} placeholder="选择任务变量" options={taskVars.map((item) => ({ value: item.key, label: `${item.label || item.key}` }))} /></Form.Item>
                if (mode === 'value') return <Form.Item {...rest} name={[name, 'sources', variable.key, 'value']} noStyle>{valueControl(variable)}</Form.Item>
                return <span className="muted small">使用脚本默认值{variable.required ? '（此变量必填）' : ''}</span>
              }}</Form.Item>
            </div>)}</div>
          }}</Form.Item>
        </div>)}
        <Button icon={<PlusOutlined aria-hidden="true" />} onClick={() => add({ optional: false, sources: {} })} disabled={fields.length >= MAX_TASK_STEPS}>添加步骤</Button>
      </>}</Form.List>

      <div className="script-section-title"><strong>定时计划</strong><span className="muted small">5 段 cron（分 时 日 月 周），本机时区、分钟粒度。</span></div>
      <Space align="start" wrap>
        <Form.Item name={['schedule', 'enabled']} label="启用定时" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item name={['schedule', 'cron']} label="cron 表达式" extra="例如 30 9 * * 1-5 表示工作日每天 9:30"><Input placeholder="* * * * *" style={{ width: 220 }} /></Form.Item>
      </Space>
      <Form.Item noStyle shouldUpdate>{() => {
        const cron = form.getFieldValue(['schedule', 'cron']) as string
        if (!cron?.trim()) return null
        const invalid = validateCron(cron)
        if (invalid) return <Alert type="warning" showIcon title={invalid} />
        const preview: string[] = []
        let base = new Date()
        for (let i = 0; i < 3; i++) { const next = cronNext(cron, base); if (!next) break; preview.push(next.toLocaleString('zh-CN')); base = next }
        return <span className="muted small">接下来运行：{preview.join(' · ') || '无匹配时间'}</span>
      }}</Form.Item>
    </Form>
  </Modal>
}
