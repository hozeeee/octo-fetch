import type { Cookie, Site } from '../../../../shared/model'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { Alert, App, Button, Checkbox, Input, InputNumber, Modal, Select, Space, Table, Tabs, Tag, Tooltip } from 'antd'
import { useEffect, useState } from 'react'
import { diffCookies, mergeCookies, parseCookieText, validateCookies } from '../../../../shared/cookies'
import { useCommand } from '../../store'

type Row = Cookie & { rowId: string }
const rows = (cookies: Cookie[]): Row[] => cookies.map((cookie) => ({ ...cookie, rowId: crypto.randomUUID() }))
const plain = (cookies: Row[]): Cookie[] => cookies.map(({ rowId: _rowId, ...cookie }) => cookie)
export function CookieEditor({ site, close }: { site: Site; close(): void }) {
  const command = useCommand()
  const { message, modal } = App.useApp()
  const [baseline, setBaseline] = useState<Cookie[]>([])
  const [draft, setDraft] = useState<Row[]>([])
  const [mode, setMode] = useState('table')
  const [source, setSource] = useState('')
  const [error, setError] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState(false)
  const [advanced, setAdvanced] = useState<{ id: string; json: string }>()
  useEffect(() => {
    let active = true
    void window.octo.cookies(site.id).then((reply) => {
      if (!active) return
      if (reply.ok) { setBaseline(reply.data.cookies); setDraft(rows(reply.data.cookies)); setPending(reply.data.pending) } else {
        setError(reply.error)
      }
    }).catch(() => { if (active) setError('读取 Cookie 失败') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [site.id])
  const update = (id: string, patch: Partial<Cookie>) => setDraft((items) => items.map((item) => item.rowId === id ? { ...item, ...patch } : item))
  const importSource = (): Cookie[] => {
    const parsed = parseCookieText(source, mode === 'json' ? 'json' : 'header', site.url)
    setWarnings(parsed.warnings)
    return mergeCookies(plain(draft), { upsert: parsed.cookies, remove: [] })
  }
  const preview = () => {
    try { setDraft(rows(importSource())); setSource(''); setMode('table'); setError('') } catch (error) { setError(error instanceof Error ? error.message : '格式错误') }
  }
  const save = async () => {
    try {
      const next = validateCookies(mode !== 'table' && source.trim() ? importSource() : plain(draft))
      setError(''); setSaving(true)
      if (await command({ type: 'cookie.apply', siteId: site.id, changes: diffCookies(baseline, next) })) {
        void message.success('Cookie 修改已保存；停止状态下将在下次启动前应用')
        close()
      }
    } catch (error) { setError(error instanceof Error ? error.message : '保存失败') } finally { setSaving(false) }
  }
  const editorTable = <>
    <div className="cookie-table-tools"><span>{draft.length} 个 Cookie {pending && <Tag color="orange">下次启动应用</Tag>}</span>
      <Button icon={<PlusOutlined />} onClick={() => setDraft((items) => [...items, { rowId: crypto.randomUUID(), name: '', value: '', domain: new URL(site.url).hostname, path: '/', secure: new URL(site.url).protocol === 'https:' }])}>添加一项</Button>
    </div>
    <Table<Row> rowKey="rowId" dataSource={draft} size="small" pagination={{ pageSize: 8, showSizeChanger: false }} scroll={{ x: 1350 }} columns={[
      { title: '名称', width: 155, render: (_, row) => <Input aria-label="Cookie 名称" value={row.name} onChange={(event) => update(row.rowId, { name: event.target.value })} /> },
      { title: '值', width: 170, render: (_, row) => <Input.Password aria-label="Cookie 值" value={row.value} onChange={(event) => update(row.rowId, { value: event.target.value })} /> },
      { title: '域', width: 165, render: (_, row) => <Input value={row.domain} onChange={(event) => update(row.rowId, { domain: event.target.value })} /> },
      { title: '路径', width: 100, render: (_, row) => <Input value={row.path} onChange={(event) => update(row.rowId, { path: event.target.value })} /> },
      { title: <Tooltip title="Unix 秒；留空或 -1 表示会话 Cookie">过期时间 ⓘ</Tooltip>, width: 155, render: (_, row) => <InputNumber style={{ width: '100%' }} min={-1} value={row.expires} placeholder="会话" onChange={(value) => update(row.rowId, { expires: value ?? undefined })} /> },
      { title: 'Secure', width: 80, render: (_, row) => <Checkbox checked={row.secure} onChange={(event) => update(row.rowId, { secure: event.target.checked })} /> },
      { title: 'HttpOnly', width: 85, render: (_, row) => <Checkbox checked={row.httpOnly} onChange={(event) => update(row.rowId, { httpOnly: event.target.checked })} /> },
      { title: 'SameSite', width: 115, render: (_, row) => <Select allowClear style={{ width: '100%' }} value={row.sameSite} options={['Strict', 'Lax', 'None'].map((value) => ({ value }))} onChange={(value) => update(row.rowId, { sameSite: value })} /> },
      { title: '操作', width: 145, fixed: 'right', render: (_, row) => <Space><Button size="small" onClick={() => setAdvanced({ id: row.rowId, json: JSON.stringify(plain([row])[0], null, 2) })}>高级</Button><Button size="small" danger aria-label="删除 Cookie" icon={<DeleteOutlined />} onClick={() => setDraft((items) => items.filter((item) => item.rowId !== row.rowId))} /></Space> }
    ]} />
  </>
  const textEditor = <div className="cookie-source">
    <p>{mode === 'json' ? '粘贴浏览器导出的 Cookie JSON 数组，导入会合并同键条目。' : '粘贴 name=value; name2=value2。默认绑定当前配置的主机与 / 路径。'}</p>
    <Input.TextArea autoSize={{ minRows: 10, maxRows: 15 }} value={source} onChange={(event) => setSource(event.target.value)} placeholder={mode === 'json' ? '[{"name":"session","value":"…","domain":"example.com","path":"/"}]' : 'session=…; preference=…'} spellCheck={false} />
    <Button onClick={preview} disabled={!source.trim()}>预览并合并到表格</Button>
  </div>
  return <Modal title={<Space>Cookie 管理 <span className="muted">/ {site.name}</span></Space>} open width={1100} onCancel={close} destroyOnHidden maskClosable={false}
    footer={<div className="modal-footer"><Button disabled={loading} onClick={() => modal.confirm({ title: '恢复最后一次快照？', content: '将合并未过期的 Cookie，不删除浏览器中其他 Cookie，也不保证登录有效。未保存的编辑将丢弃。', onOk: async () => { if (await command({ type: 'cookie.restore', siteId: site.id })) close() } })}>恢复保存的快照</Button><Space><Button onClick={close}>取消</Button><Button type="primary" loading={saving} disabled={loading || Boolean(error && !draft.length && !source)} onClick={() => void save()}>保存并应用</Button></Space></div>}>
    <Alert type="info" showIcon title="Cookie 快照加密保存在本机，浏览器完整登录目录并非全盘加密。" description="只配置你有权使用的登录态。网站可能依赖其他存储或要求重新验证。" />
    {error && <Alert type="error" showIcon title={error} className="spaced" />}
    {warnings.map((warning) => <Alert key={warning} type="warning" title={warning} className="spaced" />)}
    <Tabs activeKey={mode} onChange={(key) => { setMode(key); setSource('') }} items={[{ key: 'table', label: '逐项编辑', children: editorTable }, { key: 'json', label: 'JSON 导入', children: textEditor }, { key: 'header', label: 'Cookie 字符串', children: textEditor }]} />
    <Modal title="高级 Cookie 属性" open={Boolean(advanced)} onCancel={() => setAdvanced(undefined)} onOk={() => {
      try {
        const cookie = validateCookies([JSON.parse(advanced!.json)])[0]
        setDraft((items) => items.map((item) => item.rowId === advanced!.id ? { ...cookie, rowId: item.rowId } : item))
        setAdvanced(undefined)
      } catch (error) { void message.error(error instanceof Error ? error.message : '属性无效') }
    }}><p className="muted">可编辑 priority、sourceScheme、partitionKey 等完整属性。</p><Input.TextArea rows={14} value={advanced?.json} onChange={(event) => setAdvanced((value) => value ? { ...value, json: event.target.value } : value)} spellCheck={false} /></Modal>
  </Modal>
}
