import type { SavedScript, ScriptRun, ScriptValues } from '../../../../shared/scripts'
import { Alert, App, Button, Empty, Form, Input, InputNumber, Modal, Select, Space, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { coerceVariables, matchesUrl, scriptRunLabel } from '../../../../shared/scripts'
import { useCommand, useDesktop } from '../../store'
import { NotificationLogs } from '../notifications/NotificationLogs'

export function ScriptRunForm({ script, close, started }: { script: SavedScript; close(): void; started(): void }) {
  const snapshot = useDesktop((state) => state.snapshot)!
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const command = useCommand()
  const sandbox = script.draft.kind === 'sandbox'
  const service = sandbox && script.draft.sandbox?.mode === 'service'
  const sandboxBusy = snapshot.scriptRuns.some((run) => run.scriptId === script.id) || snapshot.scriptRuns.filter((run) => run.kind === 'sandbox').length >= 4
  const targets = snapshot.runtimes.filter((runtime) => runtime.status === 'running').flatMap((runtime) => runtime.tabs.filter((tab) => matchesUrl(script.draft.match, tab.url)).map((tab) => ({
    value: `${runtime.siteId}:${tab.id}`, label: `${snapshot.config.sites.find((site) => site.id === runtime.siteId)?.name} · ${tab.title || tab.url}`,
    disabled: snapshot.scriptRuns.some((run) => run.siteId === runtime.siteId)
  })))
  const defaults = Object.fromEntries(script.draft.variables.filter((item) => item.default !== undefined).map((item) => [item.key, item.default]))
  const initial = { ...defaults, ...script.values }
  for (const variable of script.draft.variables) {
    if (variable.kind === 'boolean' && initial[variable.key] !== undefined) initial[variable.key] = String(initial[variable.key])
  }
  return <Modal open title={`运行：${script.draft.name}`} onCancel={close} width={620} onOk={() => form.submit()} okText={service ? '启动服务' : '执行脚本'} cancelText="取消" confirmLoading={busy} okButtonProps={{ disabled: sandbox ? sandboxBusy : !targets.some((target) => !target.disabled) }}>
    <Alert type="warning" showIcon className="spaced" title={sandbox ? '沙箱拥有本机 Node.js 能力，并非安全隔离' : '脚本将使用所选网站的登录态执行'} description={sandbox ? '仅运行可信代码。可访问文件、网络和进程，停止无法撤销副作用；业务参数会明文保存，请勿输入凭据。HTTP 监听非本机地址时须自行鉴权。' : '请先检查源码并确认信任。业务参数会保存供下次使用，请勿输入凭据。取消或超时不能撤回已发送的网页操作。'} />
    {sandbox && sandboxBusy && <Alert type="info" title="该脚本已运行或已达到 4 个沙箱并发上限，请先停止实例。" className="spaced" />}
    {!sandbox && !targets.length && <Alert type="info" showIcon title="没有匹配的运行中标签" description={`请到工作台启动网站并打开适用页面：${script.draft.match.join('、')}`} className="spaced" />}
    {error && <Alert type="error" title={error} showIcon className="spaced" />}
    <Form form={form} layout="vertical" initialValues={{ target: targets.find((target) => !target.disabled)?.value, values: initial }} onFinish={async (data) => {
      if (busy) return
      setBusy(true); setError('')
      try {
        if (!sandbox && !targets.some((target) => target.value === data.target && !target.disabled)) throw new Error('所选标签已关闭、域名不匹配或已有脚本运行')
        const [siteId, tabId] = sandbox ? [] : String(data.target).split(':')
        const supplied = Object.fromEntries(Object.entries(data.values || {}).filter(([, value]) => value !== undefined && value !== null)) as ScriptValues
        const values = coerceVariables(script.draft.variables, supplied)
        if (await command({ type: 'script.run', scriptId: script.id, siteId, tabId, values })) started()
      } catch (error) { setError(error instanceof Error ? error.message : '参数无效') } finally { setBusy(false) }
    }}>
      {!sandbox && <Form.Item label="执行网站与标签" name="target" rules={[{ required: true, message: '请选择标签' }]}><Select options={targets} placeholder="选择匹配的网站标签" /></Form.Item>}
      {script.draft.variables.map((variable) => <Form.Item key={variable.key} label={variable.label} name={['values', variable.key]} rules={[{ required: variable.required, message: `请填写${variable.label}` }]} extra={`octo.vars.${variable.key}`}>
        {variable.kind === 'number' ? <InputNumber min={variable.min} max={variable.max} style={{ width: '100%' }} /> : variable.kind === 'boolean' ? <Select allowClear options={[{ value: 'true', label: '开启' }, { value: 'false', label: '关闭' }]} /> : variable.kind === 'enum' ? <Select allowClear options={variable.options?.map((value) => ({ value, label: value }))} /> : <Input maxLength={10000} />}
      </Form.Item>)}
      <span className="muted small">{sandbox ? `${service ? '初始化' : '执行'}超时：${script.draft.timeout} 秒。同脚本单实例；${service ? '就绪后常驻，退出应用自动停止。' : '返回结果后结束。'}` : `执行超时：${script.draft.timeout} 秒。同一网站同时只运行一个行动，不影响常驻注入。`}</span>
    </Form>
  </Modal>
}

export function ScriptLogs({ id, name, close }: { id: string; name: string; close(): void }) {
  const [runs, setRuns] = useState<ScriptRun[]>([])
  const [selected, setSelected] = useState<string>()
  const [notificationRun, setNotificationRun] = useState<string>()
  const [error, setError] = useState('')
  const [level, setLevel] = useState('all')
  const [busy, setBusy] = useState(false)
  const command = useCommand()
  const { modal } = App.useApp()
  const active = useDesktop((state) => state.snapshot?.scriptRuns.some((run) => run.scriptId === id) || state.snapshot?.runtimes.some((runtime) => runtime.injections?.some((item) => item.scriptId === id)))
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const reply = await window.octo.scriptRuns(id)
        if (!disposed) {
          if (reply.ok) { setRuns(reply.data); setError('') } else {
            setError(reply.error)
          }
        }
      } catch { if (!disposed) setError('无法读取运行记录') } finally { if (!disposed) timer = setTimeout(() => void refresh(), 750) }
    }
    void refresh()
    return () => { disposed = true; clearTimeout(timer) }
  }, [id])
  const run = runs.find((run) => run.id === selected) || runs[0]
  const statusLabel = scriptRunLabel
  return <Modal open title={`运行日志：${name}`} width={1000} onCancel={close} footer={<Space>
    <Button danger disabled={Boolean(active) || !runs.length} onClick={() => modal.confirm({ title: '清空此脚本的全部运行记录？', content: '此操作不可恢复。', okText: '清空', cancelText: '取消', onOk: async () => { if (await command({ type: 'script.logs.clear', id })) { setRuns([]); setSelected(undefined) } } })}>清空记录</Button>
    <Button onClick={close}>关闭</Button>
  </Space>}>
    <p className="muted">自动刷新 · 保留最近 20 次运行／网站会话，每次最近 300 条日志 · 关闭窗口不会停止运行</p>
    {error && <Alert type="error" showIcon title={error} className="spaced" />}
    {!run ? <Empty description="暂无运行记录" /> : <>
      <Select className="script-run-select" value={run.id} onChange={setSelected} options={runs.map((item) => ({ value: item.id, label: `${new Date(item.startedAt).toLocaleString()} · ${item.kind === 'sandbox' ? '独立 Node.js' : item.siteName} · ${statusLabel(item)}` }))} />
      <div className="script-log-toolbar"><Space wrap>
        <Tag color={run.status === 'success' ? 'green' : run.status === 'running' ? 'blue' : 'red'}>{statusLabel(run)}</Tag>
        <span className="small muted">版本：{new Date(run.revision).toLocaleString()}{run.endedAt && ` · 耗时 ${((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1)} 秒`}</span>
      </Space><Space>
        <Button onClick={() => setNotificationRun(run.id)}>查看关联通知</Button>
        <Select aria-label="日志等级" value={level} onChange={setLevel} options={[{ value: 'all', label: '全部日志' }, ...['info', 'warn', 'error', 'debug'].map((value) => ({ value, label: value }))]} />
        {run.kind !== 'injection' && run.status === 'running' && <Button danger loading={busy} onClick={async () => { setBusy(true); try { await command({ type: 'script.cancel', id: run.id }) } finally { setBusy(false) } }}>{run.kind === 'sandbox' ? '停止运行' : '取消执行'}</Button>}
      </Space></div>
      <Typography.Text className="small" copyable={{ text: run.id }}>运行 ID：{run.id}</Typography.Text>
      <div className="muted small script-url">{run.kind === 'sandbox' ? `独立 Node.js ${run.nodeVersion || ''} · ${run.sandbox?.mode === 'service' ? '常驻服务' : '一次性计算'}` : run.url}</div>
      {run.error && <Alert type="error" showIcon title="执行未完成" description={<pre className="script-error">{run.error}</pre>} className="spaced" />}
      <div className="script-log-view" role="log" aria-label="执行日志">{run.logs.filter((log) => level === 'all' || log.level === level).map((log, index) => <div key={`${index}:${log.time}`} className={`script-log-line ${log.level}`}><time>{new Date(log.time).toLocaleTimeString()}</time><span>{log.level.toUpperCase()}</span><pre>{log.tabId && <span className="script-log-tab" title={log.tabId}>标签 {log.tabId.slice(0, 8)} · </span>}{log.text}</pre></div>)}</div>
      {run.droppedLogs > 0 && <p className="muted small">日志达到上限，已省略 {run.droppedLogs} 条。</p>}
      {notificationRun && <Modal open title="关联通知日志" width={1100} onCancel={() => setNotificationRun(undefined)} footer={<Button onClick={() => setNotificationRun(undefined)}>关闭</Button>}><NotificationLogs runId={notificationRun} /></Modal>}
      {run.result !== undefined && <><div className="script-section-title"><strong>{run.kind === 'sandbox' && run.sandbox?.mode === 'service' ? '最新输出（非最终成功结果）' : '输出结果'}</strong><Typography.Text copyable={{ text: run.result }}>复制结果</Typography.Text></div><pre className="script-result">{(() => { try { return JSON.stringify(JSON.parse(run.result!), null, 2) } catch { return run.result } })()}</pre></>}
    </>}
  </Modal>
}
