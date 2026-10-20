import type { SavedTask } from '../../../../shared/tasks'
import { PartitionOutlined, PlusOutlined } from '@ant-design/icons'
import { Button, Empty, Space, Switch, Table, Tag, Tooltip } from 'antd'
import { useState } from 'react'
import { cronNext } from '../../../../shared/cron'
import { MAX_TASKS, TASK_STATUS_LABELS } from '../../../../shared/tasks'
import { useCommand, useDesktop } from '../../store'
import { TaskEditor } from './TaskEditor'
import { TaskRuns } from './TaskRuns'

const ORIGIN = { agent: 'Agent 生成', manual: '手动创建' }
const STATUS_COLOR: Record<string, string> = { success: 'green', partial: 'orange', error: 'red', cancelled: 'default', interrupted: 'red', running: 'blue' }

export function Tasks() {
  const snapshot = useDesktop((state) => state.snapshot)!
  const command = useCommand()
  const [editor, setEditor] = useState<{ task?: SavedTask }>()
  const [logs, setLogs] = useState<{ id: string; name: string }>()
  const tasks = snapshot.config.tasks
  const isRunning = (id: string) => snapshot.taskRuns.some((run) => run.taskId === id)
  const nextRun = (task: SavedTask) => {
    if (!task.draft.schedule.enabled) return undefined
    const next = cronNext(task.draft.schedule.cron, new Date())
    return next?.toLocaleString('zh-CN')
  }
  return <>
    <div className="page-heading"><div><span className="eyebrow">TASK ORCHESTRATION</span><h1>任务编排</h1><p>把多个行动脚本按顺序组织成可复用、可定时的任务，一次配置反复执行。</p></div><Space><Button type="primary" icon={<PlusOutlined aria-hidden="true" />} disabled={tasks.length >= MAX_TASKS} onClick={() => setEditor({})}>新建任务</Button></Space></div>
    <section className="script-intro"><span className="stat-icon green"><PartitionOutlined /></span><div><strong>脚本能力的编排层</strong><p>每个步骤固定绑定一个行动脚本与目标网站，步骤串行执行；任务变量可注入到各步骤脚本，避免重复配置。</p><span className="muted small">串行执行 · 任务变量继承 · 定时触发 · 逐步日志可追溯</span></div><div className="script-count"><strong>{tasks.length}</strong><span>个已保存任务</span></div></section>
    <div className="script-list-heading"><span className="small muted">{snapshot.taskRuns.length} 个任务运行中 · 定时使用本机时区、分钟粒度 · 数据保存在本机</span></div>
    <section className="table-panel"><Table<SavedTask> rowKey="id" scroll={{ x: 1050 }} dataSource={tasks} pagination={{ pageSize: 8, hideOnSinglePage: true }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务，创建第一个任务把多个脚本编排起来" /> }} columns={[
      { title: '任务', key: 'name', render: (_, task) => <div><strong>{task.draft.name}</strong><div className="muted small script-description">{task.draft.description || '暂无说明'}</div></div> },
      { title: '步骤 / 出错', key: 'steps', width: 150, render: (_, task) => <><Tag color="blue">{task.draft.steps.length} 步</Tag><div className="muted small">{task.draft.onError === 'stop' ? '遇错即停' : '遇错继续'} · {task.draft.variables.length} 变量</div></> },
      { title: '定时', key: 'schedule', width: 220, render: (_, task) => task.draft.schedule.enabled ? <div><Tag color="green">已启用</Tag><code className="small">{task.draft.schedule.cron}</code><div className="muted small">下次：{nextRun(task) || '—'}</div></div> : <span className="muted">未启用</span> },
      { title: '来源', key: 'origin', width: 100, render: (_, task) => <Tag color={task.origin === 'agent' ? 'green' : 'default'}>{ORIGIN[task.origin]}</Tag> },
      { title: '状态', key: 'status', width: 130, render: (_, task) => isRunning(task.id) ? <Tag color="processing">运行中</Tag> : task.lastStatus ? <div><Tag color={STATUS_COLOR[task.lastStatus] || 'default'}>{TASK_STATUS_LABELS[task.lastStatus]}</Tag>{task.lastRunAt && <div className="muted small">{new Date(task.lastRunAt).toLocaleString('zh-CN')}</div>}</div> : <span className="muted">未运行</span> },
      { title: '操作', key: 'actions', width: 260, render: (_, task) => {
        const active = isRunning(task.id); return <Space size={2} wrap>
          {active ? <Button type="link" size="small" danger onClick={() => void command({ type: 'task.cancel', id: task.id })}>取消</Button> : <Button type="link" size="small" onClick={() => void command({ type: 'task.run', id: task.id })}>运行</Button>}
          <Button type="link" size="small" onClick={() => setLogs({ id: task.id, name: task.draft.name })}>日志</Button>
          <Button type="link" size="small" disabled={active} onClick={() => setEditor({ task })}>编辑</Button>
          <Tooltip title={task.draft.schedule.cron ? '' : '请先在编辑中填写 cron 表达式'}><Switch size="small" checked={task.draft.schedule.enabled} disabled={active || !task.draft.schedule.cron} onChange={(checked) => void command({ type: 'task.enable', id: task.id, enabled: checked })} /></Tooltip>
          <Button type="link" size="small" danger disabled={active} onClick={() => void command({ type: 'task.delete', id: task.id })}>删除</Button>
        </Space>
      } }
    ]} /></section>
    {editor && <TaskEditor task={editor.task} close={() => setEditor(undefined)} />}
    {logs && <TaskRuns id={logs.id} name={logs.name} close={() => setLogs(undefined)} />}
  </>
}
