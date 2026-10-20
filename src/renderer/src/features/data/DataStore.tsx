import type { DataKind, DataPage, DataQuery, DataRecord } from '../../../../shared/data-store'
import { HddOutlined } from '@ant-design/icons'
import { Alert, App, Button, Descriptions, Empty, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { DATA_KIND_LABELS, MAX_DATA_RECORDS } from '../../../../shared/data-store'
import { useCommand, useDesktop } from '../../store'

const kindColors: Record<DataKind, string> = { action: 'blue', injection: 'purple', sandbox: 'geekblue', agent: 'green', manual: 'gold' }
function preview(value: unknown): string {
  try { const text = typeof value === 'string' ? value : JSON.stringify(value); return text.length > 120 ? `${text.slice(0, 120)}…` : text } catch { return String(value) }
}
export function DataStore() {
  const summary = useDesktop((state) => state.snapshot?.data) || { total: 0, collections: [], kinds: {} }
  const [query, setQuery] = useState<DataQuery>({ page: 1, pageSize: 20 })
  const [search, setSearch] = useState('')
  const [result, setResult] = useState<DataPage>({ items: [], total: 0 })
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<DataRecord>()
  const [version, setVersion] = useState(0)
  const { modal } = App.useApp()
  const command = useCommand()
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const response = await window.octo.dataRecords(query)
        if (!stopped) {
          if (response.ok) { setResult(response.data); setError('') } else {
            setError(response.error)
          }
        }
      } catch { if (!stopped) setError('无法读取数据仓库') } finally { if (!stopped) timer = setTimeout(() => void refresh(), 1000) }
    }
    void refresh()
    return () => { stopped = true; clearTimeout(timer) }
  }, [query, version])
  const update = (patch: Partial<DataQuery>) => setQuery((current) => ({ ...current, ...patch, page: 1 }))
  return <>
    <div className="page-heading"><div><span className="eyebrow">DATA REPOSITORY</span><h1>数据仓库</h1><p>集中存放脚本、代理与客户端产生的结构化数据，可按集合、标记和来源检索。</p></div>
      <Space>
        <Button onClick={() => command({ type: 'data.export', filter: { collection: query.collection, key: query.key, tag: query.tag, scriptId: query.scriptId, kind: query.kind, runId: query.runId, siteId: query.siteId, search: query.search } })}>导出 JSON</Button>
        <Button danger disabled={!summary.total} onClick={() => modal.confirm({ title: query.collection ? `清空集合“${query.collection}”？` : '清空全部数据？', content: '删除后无法恢复，脚本中的读写调用不受影响。', okText: '清空', cancelText: '取消', onOk: async () => { if (await command({ type: 'data.clear', collection: query.collection })) { setVersion((value) => value + 1); setQuery({ page: 1, pageSize: 20 }); setSearch('') } } })}>清空{query.collection ? '当前集合' : '全部'}</Button>
      </Space>
    </div>
    <section className="script-intro"><span className="stat-icon green"><HddOutlined /></span><div><strong>脚本用 octo.data 读写，主进程串行去重</strong><p>数据以单文件 JSON 明文保存在本机用户数据目录，非权限隔离，请勿写入凭据。</p><span className="muted small">带键去重覆盖 · 不带键追加 · 最多保留 {MAX_DATA_RECORDS} 条，超出淘汰最旧</span></div><div className="script-count"><strong>{summary.total}</strong><span>条记录</span></div></section>
    <Space wrap className="spaced">
      <Select aria-label="筛选集合" placeholder="全部集合" allowClear showSearch optionFilterProp="label" style={{ minWidth: 200 }} value={query.collection} options={summary.collections.map((item) => ({ value: item.name, label: `${item.name} · ${item.count}` }))} onChange={(collection) => update({ collection })} />
      <Select aria-label="筛选来源环境" placeholder="全部来源" allowClear style={{ minWidth: 160 }} value={query.kind} options={Object.entries(DATA_KIND_LABELS).map(([value, label]) => ({ value, label: `${label}${summary.kinds[value as DataKind] ? ` · ${summary.kinds[value as DataKind]}` : ''}` }))} onChange={(kind) => update({ kind })} />
      <Input aria-label="筛选标记" placeholder="按标记筛选" allowClear style={{ width: 160 }} value={query.tag} onChange={(event) => update({ tag: event.target.value || undefined })} />
      <Input.Search aria-label="全文检索" placeholder="搜索数据 JSON 文本" allowClear style={{ width: 260 }} value={search} onChange={(event) => { setSearch(event.target.value); if (!event.target.value) update({ search: undefined }) }} onSearch={(value) => update({ search: value || undefined })} />
      <Button onClick={() => setVersion((value) => value + 1)}>刷新</Button>
    </Space>
    {error && <Alert type="error" title={error} showIcon className="spaced" />}
    <section className="table-panel"><Table<DataRecord> rowKey="id" dataSource={result.items} scroll={{ x: 1000 }} locale={{ emptyText: <Empty description="暂无数据记录" /> }} pagination={{ current: query.page || 1, pageSize: 20, total: result.total, showSizeChanger: false, onChange: (page) => setQuery((current) => ({ ...current, page })) }} columns={[
      { title: '更新时间', dataIndex: 'updatedAt', width: 185, render: (value: string) => new Date(value).toLocaleString('zh-CN') },
      { title: '集合 / 键', render: (_, item) => <><strong>{item.collection}</strong>{item.key ? <div className="small muted">{item.key}</div> : <div className="small muted">（追加）</div>}</> },
      { title: '数据', ellipsis: true, render: (_, item) => <code className="small">{preview(item.data)}</code> },
      { title: '标记', width: 160, render: (_, item) => item.tags.length ? <Space size={2} wrap>{item.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</Space> : '—' },
      { title: '来源', width: 110, render: (_, item) => <Tag color={kindColors[item.source.kind]}>{DATA_KIND_LABELS[item.source.kind]}</Tag> },
      { title: '操作', width: 120, render: (_, item) => <Space size={4}>
        <Button type="link" onClick={() => setDetail(item)}>详情</Button>
        <Button type="link" danger onClick={() => modal.confirm({ title: '删除该记录？', content: '删除后无法恢复。', okText: '删除', cancelText: '取消', onOk: async () => { if (await command({ type: 'data.delete', id: item.id })) setVersion((value) => value + 1) } })}>删除</Button>
      </Space> }
    ]} /></section>
    {detail && <Modal open title="数据记录详情" onCancel={() => setDetail(undefined)} footer={<Button onClick={() => setDetail(undefined)}>关闭</Button>} width={720}>
      <Descriptions column={1} size="small" items={[
        { key: 'id', label: '记录 ID', children: <Typography.Text copyable>{detail.id}</Typography.Text> },
        { key: 'collection', label: '集合', children: detail.collection },
        { key: 'key', label: '键', children: detail.key || '（无键，追加记录）' },
        { key: 'tags', label: '标记', children: detail.tags.length ? <Space size={2} wrap>{detail.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</Space> : '—' },
        { key: 'kind', label: '来源环境', children: <Tag color={kindColors[detail.source.kind]}>{DATA_KIND_LABELS[detail.source.kind]}</Tag> },
        ...(['scriptName', 'scriptId', 'runId', 'siteId'] as const).filter((field) => detail.source[field]).map((field) => ({ key: field, label: field, children: <Typography.Text copyable>{detail.source[field]}</Typography.Text> })),
        { key: 'time', label: '创建 / 更新', children: `${new Date(detail.createdAt).toLocaleString('zh-CN')} / ${new Date(detail.updatedAt).toLocaleString('zh-CN')}` },
        { key: 'data', label: '数据', children: <Typography.Paragraph copyable={{ text: JSON.stringify(detail.data, null, 2) }} style={{ marginBottom: 0 }}><pre className="script-guide" style={{ margin: 0, maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(detail.data, null, 2)}</pre></Typography.Paragraph> }
      ]} />
    </Modal>}
  </>
}
