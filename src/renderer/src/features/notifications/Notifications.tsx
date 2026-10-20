import type { ChannelSummary, NotificationDetail } from '../../../../shared/notifications'
import { BellOutlined, PlusOutlined } from '@ant-design/icons'
import { Alert, App, Button, Collapse, Empty, Space, Switch, Table, Tabs, Typography } from 'antd'
import { useState } from 'react'
import { CHANNEL_LABELS, MAX_CHANNELS, NOTIFICATION_TEMPLATE } from '../../../../shared/notifications'
import { useCommand, useDesktop } from '../../store'
import { NotificationEditor } from './NotificationEditor'
import { NotificationLogs, NotificationStatusTag } from './NotificationLogs'

export function Notifications() {
  const snapshot = useDesktop((state) => state.snapshot)!
  const [editor, setEditor] = useState<{ detail?: NotificationDetail }>()
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState('channels')
  const command = useCommand()
  const { message, modal } = App.useApp()
  const edit = async (id: string) => {
    setBusy(true)
    try {
      const reply = await window.octo.notification(id)
      if (reply.ok) {
        setEditor({ detail: reply.data })
      } else {
        const channel = snapshot.config.notifications.find((item) => item.id === id)
        if (channel) setEditor({ detail: { channel, settings: {}, configured: { url: false, secret: false, password: false, headers: false } } })
        void message.warning(`${reply.error}；可重新填写完整配置修复。`)
      }
    } catch { void message.error('无法读取通知配置') } finally { setBusy(false) }
  }
  const test = (channel: ChannelSummary) => modal.confirm({ title: `向“${channel.name}”发送测试通知？`, content: '会使用已保存配置向真实接收端发送一条消息，保存中的未提交编辑不会生效。', okText: '发送测试', cancelText: '取消', onOk: async () => {
    if (await command({ type: 'notification.test', id: channel.id })) { setTab('logs'); void message.info('测试已提交，请查看发送日志中的最终结果') }
  } })
  return <>
    <div className="page-heading"><div><span className="eyebrow">NOTIFICATION CENTER</span><h1>通知管理</h1><p>统一管理接收端，让脚本专注业务，重要消息及时通知。</p></div><Button type="primary" icon={<PlusOutlined />} disabled={snapshot.notifications.length >= MAX_CHANNELS} onClick={() => setEditor({})}>新建通道</Button></div>
    <section className="script-intro"><span className="stat-icon green"><BellOutlined /></span><div><strong>一个调用，连接多个通知渠道</strong><p>行动和注入脚本统一使用 octo.notify；地址与密钥保存在本机加密配置中。</p><span className="muted small">后台发送 · 不影响主流程 · 独立日志 · 无自动重试</span></div><div className="script-count"><strong>{snapshot.notifications.length}</strong><span>个通知通道</span></div></section>
    <Tabs activeKey={tab} onChange={setTab} items={[
      { key: 'channels', label: '通知通道', children: <>
        <Collapse className="spaced" items={[{ key: 'guide', label: '脚本调用示例与发送边界', children: <><Typography.Text copyable={{ text: NOTIFICATION_TEMPLATE }}>复制示例</Typography.Text><pre className="script-guide">{NOTIFICATION_TEMPLATE}</pre><Alert type="info" title="通知必须显式指定通道" description="可传入标识数组，例如 ['ops', 'daily-mail']。只发送纯文本；无需 await，提交不代表送达。停止脚本不会撤回已接收通知，应用退出后不会续发。请勿在标题或正文中包含凭据。" /></> }]} />
        <section className="table-panel"><Table<ChannelSummary> rowKey="id" dataSource={snapshot.notifications} pagination={{ pageSize: 8, hideOnSinglePage: true }} scroll={{ x: 1000 }} locale={{ emptyText: <Empty description="暂无通知通道，创建后即可在脚本中调用" /> }} columns={[
          { title: '通道 / 调用标识', render: (_, channel) => <><strong>{channel.name}</strong><div className="small muted"><code>{channel.key}</code></div></> },
          { title: '渠道', width: 160, render: (_, channel) => CHANNEL_LABELS[channel.kind] },
          { title: '启用', width: 80, render: (_, channel) => <Switch aria-label={`启用 ${channel.key}`} checked={channel.enabled} onChange={(enabled) => void command({ type: 'notification.enable', id: channel.id, enabled })} /> },
          { title: '最近发送', width: 200, render: (_, channel) => channel.last ? <><NotificationStatusTag status={channel.last.status} /><div className="small muted">{new Date(channel.last.createdAt).toLocaleString('zh-CN')}</div></> : '尚未发送' },
          { title: '操作', width: 300, render: (_, channel) => <Space wrap size={4}>
            <Button type="link" disabled={busy} onClick={() => void edit(channel.id)}>编辑</Button>
            <Button type="link" disabled={!channel.enabled} onClick={() => test(channel)}>测试</Button>
            <Typography.Text copyable={{ text: `octo.notify(${JSON.stringify(channel.key)}, { title: '运行提醒', content: '通知内容' });` }}>调用示例</Typography.Text>
            <Button type="link" danger onClick={() => modal.confirm({ title: `删除通知通道“${channel.name}”？`, content: '尚未开始的投递将跳过；已经发出的请求无法撤回。脚本中的调用标识不会自动修改，历史日志保留。', okText: '删除', cancelText: '取消', onOk: async () => { await command({ type: 'notification.delete', id: channel.id }) } })}>删除</Button>
          </Space> }
        ]} /></section>
      </> },
      { key: 'logs', label: '发送日志', children: <NotificationLogs /> }
    ]} />
    {editor && <NotificationEditor detail={editor.detail} close={() => setEditor(undefined)} />}
  </>
}
