import type { NotificationLog, NotificationPage, NotificationQuery, NotificationStatus } from '../../../../shared/notifications'
import { Alert, App, Button, Descriptions, Empty, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { NOTIFICATION_STATUS } from '../../../../shared/notifications'
import { useCommand, useDesktop } from '../../store'

const colors: Record<NotificationStatus, string> = { queued: 'default', sending: 'blue', accepted: 'green', failed: 'red', skipped: 'gold', interrupted: 'default', unknown: 'orange' }
const sourceNames = { action: '行动脚本', injection: '注入脚本', sandbox: '沙箱脚本', test: '测试发送' }
export function NotificationStatusTag({ status }: { status: NotificationStatus }) { return <Tag color={colors[status]}>{NOTIFICATION_STATUS[status]}</Tag> }
export function NotificationLogs({ runId }: { runId?: string }) {
  const channels = useDesktop((state) => state.snapshot?.notifications || [])
  const [query, setQuery] = useState<NotificationQuery>({ page: 1, pageSize: 20 })
  const [runInput, setRunInput] = useState('')
  const [result, setResult] = useState<NotificationPage>({ items: [], total: 0 })
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<NotificationLog>()
  const [version, setVersion] = useState(0)
  const { modal } = App.useApp()
  const command = useCommand()
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const response = await window.octo.notificationLogs({ ...query, runId: runId || query.runId })
        if (!stopped) {
          if (response.ok) { setResult(response.data); setError('') } else {
            setError(response.error)
          }
        }
      } catch { if (!stopped) setError('无法读取通知日志') } finally { if (!stopped) timer = setTimeout(() => void refresh(), 1000) }
    }
    void refresh()
    return () => { stopped = true; clearTimeout(timer) }
  }, [query, runId, version])
  const update = (patch: NotificationQuery) => setQuery((current) => ({ ...current, ...patch, page: 1 }))
  return <>
    <Alert type="info" showIcon title="后台尽力发送，不自动重试" description="服务端已受理不等于已收到或已阅读；超时可能已经送达。保留最近 1,000 条终态记录，不保存正文和凭据；标题可能包含业务信息。连续超额调用会合并计数。" className="spaced" />
    {runId && <p className="small muted">关联运行：{runId}</p>}
    <Space wrap className="spaced">
      <Select aria-label="筛选通知通道" placeholder="全部通道" allowClear showSearch optionFilterProp="label" style={{ minWidth: 180 }} value={query.key} options={channels.map((item) => ({ value: item.key, label: `${item.name} · ${item.key}` }))} onChange={(key) => update({ key })} />
      <Select aria-label="筛选通知状态" placeholder="全部状态" allowClear style={{ minWidth: 160 }} value={query.status} options={Object.entries(NOTIFICATION_STATUS).map(([value, label]) => ({ value, label }))} onChange={(status) => update({ status })} />
      <Select aria-label="筛选通知来源" placeholder="全部来源" allowClear style={{ minWidth: 140 }} value={query.kind} options={Object.entries(sourceNames).map(([value, label]) => ({ value, label }))} onChange={(kind) => update({ kind })} />
      {!runId && <Input.Search aria-label="筛选运行 ID" placeholder="按运行 ID 查询" allowClear style={{ width: 280 }} value={runInput} onChange={(event) => { setRunInput(event.target.value); if (!event.target.value) update({ runId: undefined }) }} onSearch={(value) => update({ runId: value || undefined })} />}
      <Button onClick={() => setVersion((value) => value + 1)}>刷新</Button>
      {!runId && <Button danger onClick={() => modal.confirm({ title: '清空全部终态通知日志？', content: '正在排队或发送的记录保留，此操作不可恢复。', okText: '清空', cancelText: '取消', onOk: async () => { if (await command({ type: 'notification.logs.clear' })) { setVersion((value) => value + 1); setQuery({ page: 1, pageSize: 20 }) } } })}>清空终态日志</Button>}
    </Space>
    {error && <Alert type="error" title={error} showIcon className="spaced" />}
    <section className="table-panel"><Table<NotificationLog> rowKey="id" dataSource={result.items} scroll={{ x: 950 }} locale={{ emptyText: <Empty description="暂无通知记录" /> }} pagination={{ current: query.page || 1, pageSize: 20, total: result.total, showSizeChanger: false, onChange: (page) => setQuery((current) => ({ ...current, page })) }} columns={[
      { title: '提交时间', dataIndex: 'createdAt', width: 185, render: (value: string) => new Date(value).toLocaleString('zh-CN') },
      { title: '通道 / 标识', render: (_, item) => <><strong>{item.name}</strong><div className="small muted">{item.key}</div></> },
      { title: '标题', dataIndex: 'title', ellipsis: true, render: (value: string) => value || '无标题' },
      { title: '来源', width: 100, render: (_, item) => sourceNames[item.source.kind] },
      { title: '状态', width: 150, render: (_, item) => <><NotificationStatusTag status={item.status} />{item.count > 1 && <span className="small muted">合并 {item.count} 次</span>}</> },
      { title: '操作', width: 75, render: (_, item) => <Button type="link" onClick={() => setDetail(item)}>详情</Button> }
    ]} /></section>
    {detail && <Modal open title="通知投递详情" onCancel={() => setDetail(undefined)} footer={<Button onClick={() => setDetail(undefined)}>关闭</Button>} width={700}>
      <Descriptions column={1} size="small" items={[
        { key: 'id', label: '投递 ID', children: <Typography.Text copyable>{detail.id}</Typography.Text> },
        { key: 'submit', label: '提交 ID', children: <Typography.Text copyable>{detail.submissionId}</Typography.Text> },
        { key: 'channel', label: '通道', children: `${detail.name} · ${detail.key}` },
        { key: 'status', label: '状态', children: <NotificationStatusTag status={detail.status} /> },
        { key: 'title', label: '标题', children: detail.title || '无标题' },
        { key: 'source', label: '来源', children: sourceNames[detail.source.kind] },
        ...(['scriptId', 'runId', 'siteId', 'tabId'] as const).filter((key) => detail.source[key]).map((key) => ({ key, label: key, children: <Typography.Text copyable>{detail.source[key]}</Typography.Text> })),
        { key: 'time', label: '提交 / 完成', children: `${new Date(detail.createdAt).toLocaleString()} / ${detail.endedAt ? new Date(detail.endedAt).toLocaleString() : '—'}` },
        { key: 'duration', label: '耗时', children: detail.duration === undefined ? '—' : `${detail.duration} ms` },
        { key: 'count', label: '合并次数', children: detail.count },
        { key: 'code', label: '错误码', children: detail.code || '—' },
        { key: 'error', label: '原因', children: detail.error || '—' }
      ]} />
    </Modal>}
  </>
}
