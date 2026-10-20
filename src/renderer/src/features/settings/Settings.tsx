import type { Settings as GlobalSettings } from '../../../../shared/model'
import { FolderOpenOutlined, QuestionCircleOutlined, SaveOutlined } from '@ant-design/icons'
import { Alert, App, Button, Descriptions, Form, Input, InputNumber, Slider, Tooltip } from 'antd'
import { useState } from 'react'
import { userAgentSchema } from '../../../../shared/browser-options'
import { DEFAULT_SANDBOX_REGISTRY, npmRegistrySchema } from '../../../../shared/model'
import { useCommand, useDesktop } from '../../store'

export function Settings() {
  const snapshot = useDesktop((state) => state.snapshot)!
  const command = useCommand()
  const { message } = App.useApp()
  const [form] = Form.useForm<GlobalSettings>()
  const [busy, setBusy] = useState(false)
  return <>
    <div className="page-heading"><div><span className="eyebrow">GLOBAL SETTINGS</span><h1>全局配置</h1><p>平衡实时体验与本机资源，构建适合你的工作环境。</p></div></div>
    <div className="settings-layout"><section className="settings-panel"><div className="panel-title"><h3>浏览器与运行</h3><p>默认 UA 在网站下次启动时生效；其他设置即时生效，调整运行上限不会关闭已启动的网站。</p></div>
      <Form<GlobalSettings> form={form} layout="vertical" initialValues={snapshot.config.settings} onFinish={async (settings) => {
        setBusy(true)
        if (await command({ type: 'settings.save', settings })) void message.success('全局配置已保存')
        setBusy(false)
      }}>
        <Form.Item name="defaultUserAgent" label="全局默认 User-Agent" extra="网站自定义 UA / 设备预设优先；网站 UA 留空时使用此值，此处也留空则使用浏览器默认 UA。不会自动修改视口、移动模式或 Client Hints。" rules={[{ validator: async (_, value) => {
          const parsed = userAgentSchema.safeParse(value ?? '')
          if (!parsed.success) throw new Error(parsed.error.issues[0].message)
        } }]}><Input.TextArea rows={3} maxLength={4096} placeholder="留空使用浏览器默认 UA；不得包含换行或控制字符" /></Form.Item>
        <Form.Item name="maxRunning" label="最大同时运行网站数" extra="每个网站使用独立的 Chrome 进程，建议按内存容量调整。"><InputNumber min={1} precision={0} suffix="个" style={{ width: 180 }} /></Form.Item>
        <div className="form-columns"><Form.Item name="gridFps" label="网格预览帧率" extra="1～5 FPS"><InputNumber min={1} max={5} precision={0} suffix="FPS" style={{ width: '100%' }} /></Form.Item><Form.Item name="focusFps" label="放大操作帧率" extra="5～30 FPS"><InputNumber min={5} max={30} precision={0} suffix="FPS" style={{ width: '100%' }} /></Form.Item></div>
        <Form.Item name="quality" label="JPEG 画质" extra="更高画质会增加画面传输和解码开销。"><Slider min={40} max={90} marks={{ 40: '节省资源', 70: '均衡', 90: '清晰优先' }} /></Form.Item>
        <Form.Item name="navigationTimeout" label="页面导航超时" extra="超时后保留页面，允许手动重试。"><InputNumber min={10} max={120} precision={0} suffix="秒" style={{ width: 180 }} /></Form.Item>
        <Form.Item name="sandboxRegistry" label={<span>脚本 npm Registry <Tooltip title={<span>常用地址：<br />npm 官方：https://registry.npmjs.org/<br />npmmirror：https://registry.npmmirror.com/<br />腾讯云：https://mirrors.cloud.tencent.com/npm/</span>}><QuestionCircleOutlined /></Tooltip></span>} extra={<span>安装各类脚本声明的第三方包时使用；支持 HTTP / HTTPS，不要写入账号或密码。<Button type="link" size="small" onClick={() => form.setFieldValue('sandboxRegistry', DEFAULT_SANDBOX_REGISTRY)}>恢复默认</Button></span>} rules={[{ validator: async (_, value) => {
          const parsed = npmRegistrySchema.safeParse(value)
          if (!parsed.success) throw new Error(parsed.error.issues[0].message)
        } }]}><Input maxLength={2048} placeholder={DEFAULT_SANDBOX_REGISTRY} /></Form.Item>
        <Alert type="info" showIcon title="帧率为目标上限，并非固定性能承诺。" description="截图降级模式最高 5 FPS；最小化应用后暂停画面采集，网站继续运行。" />
        <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={busy} className="spaced">保存设置</Button>
      </Form>
    </section><div><section className="settings-panel"><div className="panel-title"><h3>本地数据</h3><p>配置、Cookie 快照及浏览器登录目录均保存在此。</p></div><div className="data-path">{snapshot.info.dataDir}</div><Button icon={<FolderOpenOutlined />} onClick={() => void command({ type: 'data.open' })}>打开数据目录</Button><p className="small muted">Cookie 快照通过系统钥匙串加密。完整浏览器目录仍需依赖本机账户与磁盘保护。</p></section>
      <section className="settings-panel spaced"><div className="panel-title"><h3>关于工作台</h3></div><Descriptions column={1} size="small" items={[{ key: 'version', label: '应用版本', children: `Octo Fetch ${snapshot.info.version}` }, { key: 'arch', label: '本机架构', children: snapshot.info.arch }, { key: 'chrome', label: 'Chrome', children: snapshot.info.browserVersion }, { key: 'platform', label: '运行平台', children: 'macOS' }]} /><p className="small muted">首期提供本地网站操作能力，不包含自动化采集任务。第三方网站的登录与风控兼容性需实际验证。</p></section>
    </div></div>
  </>
}
