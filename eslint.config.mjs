import antfu from '@antfu/eslint-config'

export default antfu({
  stylistic: {
    indent: 2,
    quotes: 'single',
    semi: false,
    jsx: true
  },
  typescript: true,
  react: true,
  // .gitignore 中的目录会被自动忽略，这里补充未纳入 .gitignore 的产物目录
  ignores: ['test-results*/**', '.qoder/**'],
  formatters: {
    // styles.css 采用一条规则一行的紧凑写法，Prettier 会强制展开为每个声明一行
    css: false,
    html: true,
    markdown: 'prettier'
  }
}, {
  // 项目采用同行紧凑排版（单行 if、单行多语句、同行 JSX），关闭会强制重排的布局规则
  rules: {
    'antfu/if-newline': 'off',
    'antfu/consistent-list-newline': 'off',
    'antfu/top-level-function': 'off',
    'style/max-statements-per-line': 'off',
    'style/brace-style': ['error', '1tbs', { allowSingleLine: true }],
    'style/arrow-parens': ['error', 'always'],
    'style/comma-dangle': ['error', 'never'],
    // 类型字面量存在“多行且同行多个成员用 ; 分隔”的紧凑写法，该规则无法兼容
    'style/member-delimiter-style': 'off',
    'style/lines-between-class-members': 'off',
    'style/multiline-ternary': 'off',
    'style/operator-linebreak': 'off',
    'style/jsx-one-expression-per-line': 'off',
    'style/jsx-closing-tag-location': 'off',
    'style/jsx-closing-bracket-location': 'off',
    'style/jsx-first-prop-new-line': 'off',
    'style/jsx-max-props-per-line': 'off',
    'style/jsx-wrap-multilines': 'off',
    'one-var': 'off',
    // 类型声明保持现有 type 写法；方法签名改写会改变参数双变性，不自动转换
    'ts/consistent-type-definitions': 'off',
    'ts/method-signature-style': 'off',
    // 仅检查同一作用域内的提前使用，闭包内引用后声明的变量是有意为之
    'ts/no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
    // Electron 主进程与脚本运行时直接使用 Node 全局对象
    'node/prefer-global/process': 'off',
    'node/prefer-global/buffer': 'off',
    'test/prefer-lowercase-title': 'off',
    // ref 命名沿用语义化名称（如 canvas、frame），不强制 Ref 后缀
    'react/naming-convention-ref-name': 'off',
    // 以下为需结合业务判断的 React 实践问题，保留提示但不阻塞 lint
    'react/set-state-in-effect': 'warn',
    'react/exhaustive-deps': 'warn',
    'react/no-array-index-key': 'warn'
  }
}, {
  // 主进程的 vm.createContext 返回值不是 React Context
  files: ['src/main/**'],
  rules: {
    'react/naming-convention-context-name': 'off'
  }
}, {
  // 渲染入口文件本身不参与热更新边界
  files: ['src/renderer/src/main.tsx'],
  rules: {
    'react-refresh/only-export-components': 'off'
  }
}, {
  // unused-imports 在 ESLint 10 下对 JS 文件的顶层变量误报“仅作为类型使用”，JS 文件改用内置规则
  files: ['**/*.{js,mjs,cjs}'],
  rules: {
    'unused-imports/no-unused-vars': 'off',
    'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }]
  }
})
