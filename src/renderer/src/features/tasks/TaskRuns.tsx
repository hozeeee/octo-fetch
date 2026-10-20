import type { TaskRun, TaskRunStep } from '../../../../shared/tasks'
import { Alert, App, Button, Empty, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { TASK_STATUS_LABELS, TASK_STEP_LABELS } from '../../../../shared/tasks'
import { useCommand, useDesktop } from '../../store'
import { ScriptLogs } from '../scripts/ScriptRun'

const STATUS_COLOR: Record<TaskRun['status'], string> = { running: 'blue', success: 'green', partial: 'orange', error: 'red', cancelled: 'default', interrupted: 'red' }
const STEP_COLOR: Record<TaskRunStep['status'], string> = { pending: 'default', running: 'blue', success: 'green', error: 'red', skipped: 'default', cancelled: 'default' }

export function TaskRuns({ id, name, close }: { id: string; name: string; close(): void }) {
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState('')
  const [script, setScript] = useState<{ id: string; name: string }>()
  const command = useCommand()
  const { modal } = App.useApp()
  const active = useDesktop((state) => state.snapshot?.taskRuns.some((run) => run.taskId === id))
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const reply = await window.octo.taskRuns(id)
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
  return <Modal open title={`运行记录：${name}`} width={960} onCancel={close} footer={<Space>
    <Button danger disabled={Boolean(active) || !runs.length} onClick={() => modal.confirm({ title: '清空此任务的全部运行记录？', content: '此操作不可恢复。', okText: '清空', cancelText: '取消', onOk: async () => { if (await command({ type: 'task.logs.clear', id })) { setRuns([]); setSelected(undefined) } } })}>清空记录</Button>
    <Button onClick={close}>关闭</Button>
  </Space>}>
    <p className="muted">自动刷新 · 保留最近 20 次运行 · 步骤可跳看底层脚本运行日志</p>
    {error && <Alert type="error" showIcon title={error} className="spaced" />}
    {!run ? <Empty description="暂无运行记录" /> : <>
      <Select className="script-run-select" value={run.id} onChange={setSelected} options={runs.map((item) => ({ value: item.id, label: `${new Date(item.startedAt).toLocaleString()} · ${item.trigger === 'schedule' ? '定时' : '手动'} · ${TASK_STATUS_LABELS[item.status]}` }))} />
      <div className="script-log-toolbar"><Space wrap>
        <Tag color={STATUS_COLOR[run.status]}>{TASK_STATUS_LABELS[run.status]}</Tag>
        <span className="small muted">版本：{new Date(run.revision).toLocaleString()}{run.endedAt && ` · 耗时 ${((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1)} 秒`}</span>
      </Space>{run.status === 'running' && <Button danger onClick={() => void command({ type: 'task.cancel', id })}>取消执行</Button>}</div>
      <Typography.Text className="small" copyable={{ text: run.id }}>运行 ID：{run.id}</Typography.Text>
      <Table<TaskRunStep> className="spaced" rowKey="index" size="small" dataSource={run.steps} pagination={false} columns={[
        { title: '#', dataIndex: 'index', width: 44, render: (index: number) => index + 1 },
        { title: '脚本 / 网站', key: 'target', render: (_, step) => <div><strong>{step.scriptName}</strong><div className="muted small">{step.siteName}</div></div> },
        { title: '状态', key: 'status', width: 90, render: (_, step) => <Tag color={STEP_COLOR[step.status]}>{TASK_STEP_LABELS[step.status]}</Tag> },
        { title: '耗时', key: 'duration', width: 80, render: (_, step) => <span className="small muted">{step.startedAt && step.endedAt ? `${((Date.parse(step.endedAt) - Date.parse(step.startedAt)) / 1000).toFixed(1)}s` : '—'}</span> },
        { title: '结果', key: 'detail', render: (_, step) => <Space size={4} wrap>{step.error && <span className="small" style={{ color: '#c0392b' }}>{step.error}</span>}{step.scriptRunId && <Button type="link" size="small" onClick={() => setScript({ id: step.scriptId, name: step.scriptName })}>脚本日志</Button>}</Space> }
      ]} />
    </>}
    {script && <ScriptLogs id={script.id} name={script.name} close={() => setScript(undefined)} />}
  </Modal>
}
