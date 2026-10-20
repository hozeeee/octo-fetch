# ESLint 自动格式化配置指南

本文记录如何在前端 / Node / Electron 项目中，用 **ESLint 一套工具同时负责代码检查与格式化**，并在编辑器保存时自动修复。可作为其他项目接入时的参考。

参考实现：

- `octo-fetch`：Electron + React + TS，2 空格、无分号、**紧凑 JSX** 风格（大量覆盖默认规则）
- `aga-velen-frontend`：egg.js + React，4 空格，基本沿用 antfu 默认风格

## 1. 方案概述

| 组成                                                         | 作用                                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `eslint`                                                     | 检查与修复的唯一入口                                                                     |
| `@antfu/eslint-config`                                       | 一站式规则集：JS/TS、import 排序、JSON/YAML/Markdown/TOML、风格规则（内置 `@stylistic`） |
| `eslint-plugin-format`                                       | 在 ESLint 内调用 Prettier 格式化 CSS / HTML / Markdown（可选）                           |
| `@eslint-react/eslint-plugin`、`eslint-plugin-react-refresh` | 开启 `react: true` 时所需的 peer 依赖                                                    |
| VS Code ESLint 扩展（`dbaeumer.vscode-eslint`）              | 编辑器保存时执行 `source.fixAll.eslint`                                                  |

不再单独安装 Prettier 扩展，避免两个格式化器互相覆盖。

> ESLint 9 起核心已移除格式化类规则，格式化能力来自 `@stylistic/eslint-plugin`。antfu 配置已内置它，并把规则前缀改为 `style/`。

## 2. 版本前置条件

接入前先确认版本组合，否则会出现 peer 依赖冲突：

| `@antfu/eslint-config` | 需要的 ESLint                                     | Node                           |
| ---------------------- | ------------------------------------------------- | ------------------------------ |
| 9.x                    | `>=10.4`（其依赖的 `eslint-plugin-unicorn` 要求） | `^20.19 \|\| ^22.13 \|\| >=24` |
| 7.x                    | `^9.10`                                           | 18+                            |

- 项目 Node 版本过低、无法升级 ESLint 10 时，使用 antfu 7.x（`aga-velen-frontend` 即为 7.2.0 + ESLint 9 + Node 18）。
- 安装后执行 `npm ls eslint`，出现 `invalid` 即说明版本组合不匹配。

## 3. 安装依赖

```bash
# 移除被 antfu 内置替代的旧依赖（按项目实际情况）
npm uninstall @eslint/js typescript-eslint @stylistic/eslint-plugin globals

# 核心
npm install -D eslint @antfu/eslint-config
# React 项目
npm install -D @eslint-react/eslint-plugin eslint-plugin-react-refresh
# 需要格式化 CSS / HTML / Markdown 时
npm install -D eslint-plugin-format
```

## 4. `eslint.config.mjs`

### 4.1 最小模板

```js
import antfu from '@antfu/eslint-config'

export default antfu({
  stylistic: {
    indent: 2, // 或 4
    quotes: 'single',
    semi: false,
    jsx: true
  },
  typescript: true,
  react: true,
  // .gitignore 已自动生效，这里只补充未被忽略的产物目录
  ignores: ['test-results*/**'],
  formatters: {
    css: true,
    html: true,
    markdown: 'prettier'
  }
}, {
  // 第二个及之后的参数是普通 flat config，用于覆盖规则
  rules: {}
})
```

### 4.2 规则前缀对照

antfu 会重命名插件前缀。写覆盖规则和 `eslint-disable` 注释时**必须使用新前缀**，否则会报 `Definition for rule ... was not found`：

| 原插件                                   | antfu 中的前缀 |
| ---------------------------------------- | -------------- |
| `@typescript-eslint/*`                   | `ts/*`         |
| `@stylistic/*`                           | `style/*`      |
| `eslint-plugin-n`                        | `node/*`       |
| `eslint-plugin-import-x` / `import-lite` | `import/*`     |
| `@vitest/eslint-plugin`                  | `test/*`       |
| `@eslint-react/*`                        | `react/*`      |

迁移时执行一次 `grep -rn "eslint-disable" src`，把旧前缀批量改掉。

### 4.3 紧凑风格项目的常用覆盖

如果项目习惯单行 `if`、单行多语句、同行 JSX，antfu 默认规则会大面积重排代码。以下是 `octo-fetch` 的覆盖清单（放在 `antfu()` 第二个参数的 `rules` 中），可按需取用：

```js
export const compactRules = {
  // 布局类：保留单行写法
  'antfu/if-newline': 'off', // 允许 if (x) return
  'antfu/consistent-list-newline': 'off', // 允许对象/数组部分换行
  'antfu/top-level-function': 'off', // 允许顶层箭头函数
  'style/max-statements-per-line': 'off',
  'style/brace-style': ['error', '1tbs', { allowSingleLine: true }],
  'style/lines-between-class-members': 'off',
  'style/multiline-ternary': 'off',
  'style/operator-linebreak': 'off',
  'style/member-delimiter-style': 'off', // 类型字面量多行内同行多个成员用 ; 分隔
  'style/jsx-one-expression-per-line': 'off',
  'style/jsx-closing-tag-location': 'off',
  'style/jsx-closing-bracket-location': 'off',
  'style/jsx-first-prop-new-line': 'off',
  'style/jsx-max-props-per-line': 'off',
  'style/jsx-wrap-multilines': 'off',
  // 与既有习惯一致
  'style/arrow-parens': ['error', 'always'],
  'style/comma-dangle': ['error', 'never'],
  'one-var': 'off',
  // 避免改变类型语义
  'ts/consistent-type-definitions': 'off', // 不强制 type → interface
  'ts/method-signature-style': 'off', // 改写会改变参数双变性
  'ts/no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
  // Node / Electron 直接使用全局对象
  'node/prefer-global/process': 'off',
  'node/prefer-global/buffer': 'off'
}
```

**取舍原则**：保留 antfu 的代码质量规则（regexp、unicorn、React、import 排序、`import type`），只关闭会**大面积重排既有风格**或**可能改变语义**的规则。需要业务判断的 React 规则（`react/set-state-in-effect`、`react/exhaustive-deps`、`react/no-array-index-key`）可降为 `warn`，保留提示但不阻塞 lint。

### 4.4 按目录覆盖

作为 `antfu()` 的后续参数传入：

```js
export const scopedOverrides = [{
  // Node 的 vm.createContext 返回值会被误判为 React Context
  files: ['src/main/**'],
  rules: { 'react/naming-convention-context-name': 'off' }
}, {
  // 渲染入口文件不参与热更新边界
  files: ['src/renderer/src/main.tsx'],
  rules: { 'react-refresh/only-export-components': 'off' }
}]
```

## 5. `package.json` 脚本

```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "eslint . --fix",
    "lint:inspect": "npx @eslint/config-inspector"
  }
}
```

`lint:inspect` 会打开可视化页面，查看每个文件最终生效的规则，排查“某条规则为什么生效 / 不生效”时很有用。

## 6. 编辑器配置（保存时自动格式化）

**只配置 `eslint.config.mjs` 和 npm 脚本，保存文件时不会触发格式化**，必须同时配置编辑器。

### 6.1 `.vscode/settings.json`

```jsonc
{
  // 关闭其他格式化器，统一由 ESLint 负责
  "prettier.enable": false,
  "editor.formatOnSave": false,

  // 保存时自动修复
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit",
    "source.organizeImports": "never"
  },

  // 编辑器中静默格式类规则，但保存时仍自动修复
  "eslint.rules.customizations": [
    { "rule": "style/*", "severity": "off", "fixable": true },
    { "rule": "format/*", "severity": "off", "fixable": true },
    { "rule": "perfectionist/*", "severity": "off", "fixable": true },
    { "rule": "*-indent", "severity": "off", "fixable": true },
    { "rule": "*-spacing", "severity": "off", "fixable": true },
    { "rule": "*-spaces", "severity": "off", "fixable": true },
    { "rule": "*-order", "severity": "off", "fixable": true },
    { "rule": "*-dangle", "severity": "off", "fixable": true },
    { "rule": "*-newline", "severity": "off", "fixable": true },
    { "rule": "*quotes", "severity": "off", "fixable": true },
    { "rule": "*semi", "severity": "off", "fixable": true }
  ],

  // 让 ESLint 扩展处理这些语言（按 formatters 实际开启情况增减 css/less/scss）
  "eslint.validate": [
    "javascript",
    "javascriptreact",
    "typescript",
    "typescriptreact",
    "html",
    "markdown",
    "json",
    "jsonc",
    "yaml",
    "toml"
  ],

  // 手动“格式化文档”（Shift+Option+F）也走 ESLint
  "eslint.format.enable": true,
  "[typescript]": { "editor.defaultFormatter": "dbaeumer.vscode-eslint" },
  "[typescriptreact]": { "editor.defaultFormatter": "dbaeumer.vscode-eslint" },
  "[javascript]": { "editor.defaultFormatter": "dbaeumer.vscode-eslint" },
  "[javascriptreact]": { "editor.defaultFormatter": "dbaeumer.vscode-eslint" }
}
```

各项作用：

- `editor.codeActionsOnSave` → `source.fixAll.eslint`：**保存时自动修复的关键配置**。
- `editor.formatOnSave: false`、`prettier.enable: false`：避免其他格式化器在 ESLint 之后再改一遍。
- `eslint.rules.customizations`：格式问题在编辑器中不显示红线（保存即修复），只保留真正的代码问题提示。
- `eslint.validate`：默认只处理 JS/TS，需要显式加入 JSON、Markdown 等语言。

### 6.2 `.vscode/extensions.json`

```json
{
  "recommendations": ["dbaeumer.vscode-eslint"]
}
```

团队成员打开项目时会收到安装扩展的提示。

> 注意：`.vscode/` 不能写进 `.gitignore`，否则团队成员拿不到这些设置。

## 7. 首次接入流程

1. **记录基线**：先跑 `typecheck`、单元测试，确认全部通过，用于之后判断修复是否引入问题。
2. **确保工作区干净**：先提交或暂存手头改动，方便审阅和回退全量格式化。
3. **统计问题分布**：

   ```bash
   npx eslint . -f json -o /tmp/lint.json
   node -e "const r=require('/tmp/lint.json');const m={};for(const x of r)for(const e of x.messages)m[e.ruleId]=(m[e.ruleId]||0)+1;console.log(Object.entries(m).sort((a,b)=>b[1]-a[1]))"
   ```

   数量排前几位的规则通常就是与项目风格冲突的规则，结合源码判断是关闭还是接受。

4. **抽样试修**：`npx eslint --fix <典型文件>`，用 `git diff` 检查结果，不满意就 `git checkout <文件>` 还原，再调整规则。
5. **全量修复**：`npm run format`。
6. **按文件类型审阅 diff**：`git diff --stat` 排序后，重点看改动异常大的文件（例如 CSS 被 Prettier 展开）。
7. **回归验证**：`typecheck` + 单元测试 + 生产构建。`import type` 改写会移除仅作类型使用的运行时导入，需要靠构建确认。
8. **处理剩余问题**：无法自动修复的问题逐条判断——确属误报的用 `// eslint-disable-next-line <规则> -- 原因` 并写明原因；确属问题的修改代码；需要业务判断的降为 `warn`。

## 8. 常见问题

### 保存时没有触发格式化

- 没有配置 `.vscode/settings.json` 的 `source.fixAll.eslint`（最常见）。
- 没有安装 `dbaeumer.vscode-eslint` 扩展。
- 修改配置后扩展仍在使用旧配置：执行命令面板的 **ESLint: Restart ESLint Server**，或重新加载窗口。
- 查看状态栏 ESLint 图标或 **输出 → ESLint** 面板中的报错。

### 编辑器提示与命令行结果不一致

编辑器扩展可能缓存旧配置。以 `npx eslint <文件>` 的结果为准，不要根据编辑器提示去改配置。

### JS 文件中被使用的变量报 “only used as a type”

ESLint 10 下，`unused-imports/no-unused-vars`（包装的 typescript-eslint 规则）会对 `.js/.mjs/.cjs` 文件的顶层变量误报。JS 文件改用内置规则：

```js
export const jsFilesOverride = {
  files: ['**/*.{js,mjs,cjs}'],
  rules: {
    'unused-imports/no-unused-vars': 'off',
    'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }]
  }
}
```

### CSS 被展开成每个声明一行

Prettier 没有保留单行规则的选项。如果项目 CSS 采用一条规则写一行的紧凑写法，设置 `formatters.css: false`，同时从 `eslint.validate` 中移除 `css/less/scss`。

### `package.json` 字段顺序被调整

antfu 的 `jsonc/sort-keys` 会按 npm 惯例排序 `package.json`、`tsconfig.json` 的键，内容不变，属于预期行为。

### 正则捕获组提示 `regexp/no-unused-capturing-group`

只用 `.test()` 时，把 `(a|b)` 改为非捕获组 `(?:a|b)` 即可，语义不变。

## 9. 检查清单

- [ ] `npm ls eslint` 无 `invalid`
- [ ] `npm run lint` 无 error
- [ ] `typecheck`、单元测试、构建均通过
- [ ] 旧前缀的 `eslint-disable` 注释已改为 antfu 前缀
- [ ] `.vscode/settings.json`、`.vscode/extensions.json` 已提交
- [ ] 在编辑器中故意加一个分号并保存，确认会被自动移除
