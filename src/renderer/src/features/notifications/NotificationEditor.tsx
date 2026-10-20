import type { ChannelDraft, NotificationDetail, NotificationPatch } from '../../../../shared/notifications'
import { Alert, Button, Checkbox, Form, Input, InputNumber, Modal, Select, Space, Switch } from 'antd'
import { useState } from 'react'
import { CHANNEL_LABELS, channelDraftSchema, notificationPatchSchema } from '../../../../shared/notifications'
import { useCommand } from '../../store'

type Values = ChannelDraft & { settings: NotificationPatch; clearSecret?: boolean; clearHeaders?: boolean }
export function NotificationEditor({ detail, close }: { detail?: NotificationDetail; close(): void }) {
  const [form] = Form.useForm<Values>()
  const kind = Form.useWatch('kind', form) || detail?.channel.kind || 'dingtalk'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const command = useCommand()
  const configured = detail?.configured
  const required = [{ required: true, message: '请填写此项' }]
  const hint = (saved?: boolean) => saved ? '已配置；留空保留，填写则替换' : '尚未配置'
  return <Modal open title={detail ? '编辑通知通道' : '新建通知通道'} width={720} onCancel={close} maskClosable={false} okText="保存通道" cancelText="取消" confirmLoading={busy} onOk={() => form.submit()}>
    <Alert type="info" showIcon className="spaced" title="配置保存在本机，敏感字段通过系统钥匙串加密" description="保存不会发送消息；发送使用本机网络，不继承网站代理。机器人关键词可通过正文前缀配置。" />
    {error && <Alert type="error" showIcon title={error} className="spaced" />}
    <Form form={form} layout="vertical" initialValues={detail ? { ...detail.channel, settings: detail.settings } : { name: '', key: '', kind: 'dingtalk', enabled: true, prefix: '', settings: {} }} onFinish={async (values) => {
      if (busy) return
      try {
        const draft = channelDraftSchema.parse({ name: values.name, key: values.key, kind: values.kind, enabled: values.enabled, prefix: values.prefix || '' })
        const settings: NotificationPatch = Object.fromEntries(Object.entries(values.settings || {}).filter(([, value]) => value !== undefined))
        for (const key of ['url', 'secret', 'password'] as const) {
          if (!settings[key]) delete settings[key]
        }
        if (!settings.headers?.length) delete settings.headers
        if (values.clearSecret) settings.secret = null
        if (values.clearHeaders) settings.headers = null
        const parsed = notificationPatchSchema.safeParse(settings)
        if (!parsed.success) { setError(`配置格式无效：${parsed.error.issues.map((item) => `${item.path.join('.')} ${item.message}`).join('；')}`); return }
        setBusy(true); setError('')
        if (await command({ type: 'notification.save', id: detail?.channel.id, draft, settings: parsed.data })) close()
      } catch { setError('请检查名称、调用标识和配置格式') } finally { setBusy(false) }
    }}>
      <div className="form-columns"><Form.Item name="name" label="显示名称" rules={required}><Input maxLength={80} placeholder="例如：运维群通知" /></Form.Item><Form.Item name="key" label="调用标识" rules={[...required, { pattern: /^[a-z][a-z0-9_-]{1,63}$/, message: '小写英文开头，2–64 位英文、数字、下划线或连字符' }]} extra="创建后不可修改，脚本通过此标识调用"><Input disabled={Boolean(detail)} placeholder="例如：ops" maxLength={64} /></Form.Item></div>
      <div className="form-columns"><Form.Item name="kind" label="渠道类型"><Select disabled={Boolean(detail)} options={Object.entries(CHANNEL_LABELS).map(([value, label]) => ({ value, label }))} onChange={() => { form.setFieldValue('settings', {}); form.setFieldsValue({ clearSecret: false, clearHeaders: false }); setError('') }} /></Form.Item><Form.Item name="enabled" label="启用状态" valuePropName="checked"><Switch /></Form.Item></div>
      <Form.Item name="prefix" label="正文前缀" extra="可选；机器人开启关键词校验时，在此填写所需关键词"><Input maxLength={500} /></Form.Item>
      {kind !== 'smtp' && <Form.Item name={['settings', 'url']} label="Webhook 地址" rules={configured?.url ? [] : required} extra={hint(configured?.url)} preserve={false}><Input.Password autoComplete="new-password" placeholder={kind === 'webhook' ? 'https://your-service.example/notify' : '粘贴官方机器人 Webhook 地址'} /></Form.Item>}
      {(kind === 'dingtalk' || kind === 'feishu') && <>
        <Form.Item name={['settings', 'secret']} label="签名密钥（可选）" extra={hint(configured?.secret)} preserve={false}><Input.Password autoComplete="new-password" /></Form.Item>
        {configured?.secret && <Form.Item name="clearSecret" valuePropName="checked" preserve={false}><Checkbox>清除已保存的签名密钥</Checkbox></Form.Item>}
      </>}
      {kind === 'smtp' && <>
        <div className="form-columns"><Form.Item name={['settings', 'host']} label="SMTP 主机" rules={required} preserve={false}><Input placeholder="smtp.example.com" /></Form.Item><Form.Item name={['settings', 'port']} label="SMTP 端口" rules={required} preserve={false}><InputNumber min={1} max={65535} placeholder="465 / 587" style={{ width: '100%' }} /></Form.Item></div>
        <Form.Item name={['settings', 'security']} label="连接安全" rules={required} preserve={false}><Select options={[{ value: 'tls', label: 'TLS（通常为 465）' }, { value: 'starttls', label: '强制 STARTTLS（通常为 587）' }]} /></Form.Item>
        <div className="form-columns"><Form.Item name={['settings', 'username']} label="认证账号" rules={required} preserve={false}><Input autoComplete="off" /></Form.Item><Form.Item name={['settings', 'password']} label="密码 / 授权码" rules={configured?.password ? [] : required} extra={hint(configured?.password)} preserve={false}><Input.Password autoComplete="new-password" /></Form.Item></div>
        <Form.Item name={['settings', 'from']} label="发件邮箱" rules={[...required, { type: 'email', message: '请输入邮箱地址' }]} preserve={false}><Input /></Form.Item>
        <Form.Item name={['settings', 'to']} label="收件邮箱" rules={required} extra="输入邮箱后按回车，可添加多个" preserve={false}><Select mode="tags" tokenSeparators={[',', ';', ' ']} /></Form.Item>
        <Form.Item name={['settings', 'cc']} label="抄送邮箱" preserve={false}><Select mode="tags" tokenSeparators={[',', ';', ' ']} /></Form.Item>
      </>}
      {kind === 'webhook' && <>
        <Form.Item name={['settings', 'allowHttp']} valuePropName="checked" preserve={false}><Checkbox>允许 HTTP 明文连接（仅用于可信本机/内网服务）</Checkbox></Form.Item>
        <p className="muted small">固定 POST JSON：id、title、content、createdAt、source。仅 HTTP 2xx 视为接口受理，不解析业务返回值。</p>
        <p>自定义 Header <span className="muted small">{hint(configured?.headers)}；填写新列表会替换全部 Header</span></p>
        <Form.List name={['settings', 'headers']}>
          {(fields, { add, remove }) => <>{fields.map((field) => <Space key={field.key} align="baseline" style={{ display: 'flex' }}><Form.Item name={[field.name, 'name']} rules={required}><Input placeholder="Header 名称" aria-label="Header 名称" /></Form.Item><Form.Item name={[field.name, 'value']} rules={required}><Input.Password placeholder="Header 值" aria-label="Header 值" autoComplete="new-password" /></Form.Item><Button onClick={() => remove(field.name)}>移除</Button></Space>)}<Button onClick={() => add({ name: '', value: '' })} disabled={fields.length >= 30}>添加 Header</Button></>}
        </Form.List>
        {configured?.headers && <Form.Item name="clearHeaders" valuePropName="checked"><Checkbox>清除全部已保存 Header</Checkbox></Form.Item>}
      </>}
    </Form>
  </Modal>
}
