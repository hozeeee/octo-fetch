# Octo Fetch

基于 Puppeteer 的本地网站操作工作台。桌面端（Electron）统一管理多个相互隔离的浏览器实例，提供实时远程画面、可复用脚本、任务编排、抓包调试、通知推送、数据仓库，并通过 MCP 服务开放给 AI 客户端调用。

> 当前仅支持 macOS（arm64 / x64）。内置 Chrome 由 `@puppeteer/browsers` 下载，版本与 `puppeteer-core` 保持一致。

## 功能概览

| 模块     | 说明                                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 网站管理 | 每个网站配置对应独立浏览器与登录目录；支持视口、UA、设备预设、语言、时区、地理位置、额外请求头、代理等浏览器选项；Cookie 加密快照、恢复与编辑                                                         |
| 工作台   | 实时画面串流与鼠标 / 键盘远程输入，多标签切换，网页对话框应答                                                                                                                                         |
| 脚本     | 三类脚本：**行动**（绑定网站与标签，有界执行）、**注入**（随网站启动逐标签安装，可改写请求 / 响应）、**沙箱**（独立 Node.js 进程，支持一次性与常驻服务两种模式）；支持参数变量和按脚本隔离的 npm 依赖 |
| 任务编排 | 将多个行动脚本串成步骤，步骤参数可引用任务变量；5 段 cron 定时调度（本机时区），失败策略可选停止或继续                                                                                                |
| 抓包调试 | 基于 Whistle 的代理服务，CA 证书生成与导出，上游代理（HTTP / HTTPS / SOCKS5），局域网访问控制，脚本访问分级授权                                                                                       |
| 通知管理 | 钉钉、企业微信、飞书机器人，SMTP 邮件，通用 Webhook；支持测试发送、限流与投递日志                                                                                                                     |
| 数据仓库 | 供脚本读写的本地集合存储，按键去重覆盖或追加，支持标记、组合查询与分页                                                                                                                                |
| MCP 服务 | 仅监听 `127.0.0.1`，Bearer 令牌鉴权，按 read / operate / full 三级身份裁剪工具                                                                                                                        |
| 设置     | 并发上限、帧率、画质、导航超时、默认 UA、npm registry 等全局配置                                                                                                                                      |

## 快速开始

环境要求：macOS、Node.js `>= 22.12.0`、npm。

```bash
npm install              # postinstall 会执行 electron-builder install-app-deps
npm run browser:prepare  # 下载与当前架构匹配的 Chrome 到 .browsers/<arch>/
npm run dev              # 开发模式启动
```

未执行 `browser:prepare` 时应用可以打开，但网站无法启动浏览器。

开发模式下可用 `OCTO_DATA_DIR` 指定独立的数据目录，避免与日常数据混用：

```bash
OCTO_DATA_DIR=./.octo-data npm run dev
```

## 常用命令

| 命令                                      | 说明                                                     |
| ----------------------------------------- | -------------------------------------------------------- |
| `npm run dev`                             | 开发模式（electron-vite，渲染进程热更新）                |
| `npm run start`                           | 预览构建产物                                             |
| `npm run build`                           | 类型检查并构建到 `out/`                                  |
| `npm run typecheck`                       | `tsc --noEmit`                                           |
| `npm run lint` / `npm run lint:fix`       | ESLint 检查 / 自动修复（同时负责格式化）                 |
| `npm test`                                | Vitest 单元测试（`tests/unit`）                          |
| `npm run test:e2e`                        | 构建后运行 Playwright 端到端测试（`tests/e2e`）          |
| `npm run browser:prepare`                 | 下载内置 Chrome，可加 `-- --arm64` / `-- --x64` 指定架构 |
| `npm run pack`                            | 构建并生成未压缩的 `.app`（`dist/`）                     |
| `npm run dist:arm64` / `npm run dist:x64` | 构建并生成对应架构的 `.dmg` 与 `.zip`                    |
| `npm run test:pack:<arm64\|x64>`          | 对打包产物执行沙箱冒烟测试                               |
| `npm run test:pack:capture:<arm64\|x64>`  | 对打包产物执行抓包相关测试                               |

## 脚本

脚本源码是异步函数体，支持顶层 `await`、`require()` 与动态 `import()`。第三方包需在编辑器中声明依赖、保存并安装成功后才能使用，每个脚本使用独立的 `node_modules`。

运行时可用的主要上下文：

| 名称                                               | 行动 | 注入 | 沙箱 | 说明                                               |
| -------------------------------------------------- | :--: | :--: | :--: | -------------------------------------------------- |
| `page` / `browser`                                 |  ✓   |  ✓   |      | Puppeteer 实例                                     |
| `octo.site`                                        |  ✓   |  ✓   |      | 当前网站与标签信息                                 |
| `octo.vars`                                        |  ✓   |  ✓   |  ✓   | 已校验的脚本参数（text / number / boolean / enum） |
| `octo.log` / `console`                             |  ✓   |  ✓   |  ✓   | 写入运行日志                                       |
| `octo.sleep(ms)`                                   |  ✓   |  ✓   |  ✓   | 等待                                               |
| `octo.output(value)`                               |  ✓   |      |  ✓   | 暂存结果，`return` 值同样作为结果                  |
| `octo.notify(target, message)`                     |  ✓   |  ✓   |  ✓   | 发送到通知管理中配置的通道 key                     |
| `octo.data`                                        |  ✓   |  ✓   |  ✓   | 数据仓库客户端，方法均返回 Promise                 |
| `octo.capture`                                     |  ✓   |  ✓   |  ✓   | 抓包客户端，需开启抓包模块开关并授权脚本           |
| `octo.interceptRequest` / `octo.interceptResponse` |      |  ✓   |      | 统一的网络改写 API                                 |
| `octo.onDispose(fn)`                               |      |  ✓   |  ✓   | 注册清理函数                                       |

行动脚本示例：

```js
console.log('开始运行', octo.site.name)
await page.waitForSelector('body')
const title = await page.title()
octo.output({ title, url: page.url() })
```

注入脚本示例（改写接口响应）：

```js
octo.interceptResponse({ urlPattern: '*/api/*' }, ({ response }) => {
  const data = JSON.parse(response.body)
  return { body: JSON.stringify({ ...data, injected: true }) }
})
```

注入脚本在网站配置中绑定，修改后需重启网站生效。完整的脚本契约与模板见 [src/shared/scripts.ts](src/shared/scripts.ts)，MCP 客户端可通过 `script_guide` 工具获取。

## MCP 服务

在「MCP」页面启用服务并创建身份令牌，默认端点：

```
http://127.0.0.1:8787/mcp
```

传输方式为 Streamable HTTP，请求需携带 `Authorization: Bearer <token>`。端口可在页面中修改。

| 等级    | 典型工具                                                                                                                                                                               |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| read    | `list_sites`、`list_tabs`、`read_page`、`capture_screenshot`、`get_settings`、`list_scripts`、`read_script`、`script_guide`、`list_tasks`、`read_task_runs`、`list_data`、`read_data`  |
| operate | `start_site`、`stop_site`、`open_tab`、`navigate`、`go_history`、`answer_dialog`、`capture_cookies`、`write_data`                                                                      |
| full    | `click`、`type_text`、`press_key`、`scroll`、`save_site`、`save_settings`、Cookie 读写、`save_script`、`run_script`、`install_dependencies`、`save_task`、`run_task`、`delete_data` 等 |

抓包相关工具（`capture_status`、`capture_requests`、`capture_detail`、`capture_start`、`capture_stop`）另受抓包设置中的 MCP 开关与授权控制。完整清单见 [src/main/mcp](src/main/mcp)。

## 项目结构

```
src/
├── main/            # Electron 主进程
│   ├── browser/     # 浏览器实例、画面串流、远程输入、网络拦截
│   ├── capture/     # Whistle 抓包服务、证书、上游代理
│   ├── ipc/         # 渲染进程 IPC 注册与来源校验
│   ├── mcp/         # MCP 服务、工具与令牌
│   ├── notifications/
│   ├── scripts/     # 脚本运行器、Worker、沙箱进程、依赖安装
│   ├── storage/     # 配置、数据仓库、加密凭据
│   ├── tasks/       # 任务编排与 cron 调度
│   └── index.ts     # 应用入口
├── preload/         # contextBridge 暴露的桌面 API
├── renderer/        # React + Ant Design 界面（按 features/ 划分）
└── shared/          # 主进程与渲染进程共享的类型和 Zod 校验
scripts/             # 浏览器准备与打包脚本
tests/               # unit（Vitest）与 e2e（Playwright）
```

## 数据存储

应用数据位于 Electron `userData` 目录（macOS 下为 `~/Library/Application Support/<应用名>`），主要包括：

- `config.json`：网站、脚本、任务、通知、MCP 等配置（令牌仅存哈希）
- `data-store.json`：数据仓库
- Cookie 快照、代理凭据等敏感信息以加密形式单独存放

## 打包与发布

`npm run dist:<arch>` 会先执行 `browser:prepare`，再通过 electron-builder 将 Chrome 作为 `extraResources` 打入应用，产物输出到 `dist/`。

可选环境变量：

| 变量                                                         | 作用                       |
| ------------------------------------------------------------ | -------------------------- |
| `CSC_LINK` / `CSC_KEY_PASSWORD`                              | 代码签名证书               |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | 三者齐备时执行公证         |
| `OCTO_ELECTRON_DIST`                                         | 使用本地 Electron 发行目录 |

推送 `v*` 标签（需与 `package.json` 的 `version` 一致）或手动触发时，[GitHub Actions](.github/workflows/release.yml) 会依次执行 lint、类型检查和单元测试，在 macOS 上构建 arm64 / x64 双架构并冒烟测试；标签触发时创建 GitHub Release 并上传产物。

## 开发规范

项目使用 `@antfu/eslint-config` 统一检查与格式化（2 空格、无分号、紧凑 JSX），不单独使用 Prettier。推荐安装 VS Code ESLint 扩展并开启保存时修复，详见 [docs/ESLint自动格式化配置指南.md](docs/ESLint自动格式化配置指南.md)。
