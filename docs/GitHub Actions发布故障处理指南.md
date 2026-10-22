# GitHub Actions 发布故障处理指南

本文记录 Octo Fetch 发布流程的常见排查方式，以及修复 macOS x64 冒烟测试超时后重新触发发布的操作。

## 检查仓库状态

查看当前提交、版本、本地状态及远端分支和标签：

```bash
git log --oneline -4 --decorate
grep -m1 '"version"' package.json
git status -sb
git ls-remote --heads --tags origin
```

重点确认：

- `package.json` 中的版本与发布标签一致，例如版本 `0.1.0` 对应标签 `v0.1.0`。
- 标签指向包含修复代码的提交。
- 本地分支已经推送到远端。
- `.github/workflows/release.yml` 已包含在标签对应的提交中。

## macOS x64 冒烟测试启动超时

典型错误：

```text
TimeoutError: electron.launch: Timeout 90000ms exceeded
```

如果 arm64 构建与冒烟测试成功，而 x64 应用在 Apple Silicon runner 上启动超时，通常是因为 x64 Electron 应用需要通过 Rosetta 运行。涉及 Electron、Playwright 和子进程时，跨架构执行可能不稳定。

应为不同架构选择原生 runner：

```yaml
jobs:
  build:
    name: Build macOS (${{ matrix.arch }})
    runs-on: ${{ matrix.runner }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - arch: arm64
            runner: macos-latest
          - arch: x64
            runner: macos-15-intel
```

同时按架构隔离 Electron 缓存，防止复用其他架构的缓存：

```yaml
- name: Cache Electron binaries
  uses: actions/cache@v4
  with:
    path: |
      ~/Library/Caches/electron
      ~/Library/Caches/electron-builder
    key: electron-${{ runner.os }}-${{ matrix.arch }}-${{ hashFiles('package-lock.json') }}
```

## 验证修改

检查 diff 中是否存在空白或格式问题：

```bash
git diff --check
```

以 CI 环境运行 lint：

```bash
CI=true npm run lint
```

验证 workflow YAML 可以解析，并包含构建矩阵：

```bash
node -e "
const fs = require('fs')
const YAML = require('yaml')
const data = YAML.parse(fs.readFileSync('.github/workflows/release.yml', 'utf8'))
if (!data.jobs?.build?.strategy?.matrix?.include) process.exit(1)
console.log(data.jobs.build.strategy.matrix.include)
"
```

根据修改范围，还应运行：

```bash
npm run typecheck
npm test
```

## 提交并推送修复

```bash
git add .github/workflows/release.yml
git commit -m "fix(ci): 使用原生 Intel runner 构建 x64"
git push origin master
```

## 使用新标签触发发布

推荐使用尚未发布的新版本，而不是移动已有标签。先确保 `package.json` 与 `package-lock.json` 版本一致，然后执行：

```bash
git add package.json package-lock.json
git commit -m "chore(release): 发布 0.1.1"
git push origin master
git tag v0.1.1
git push origin v0.1.1
```

推送 `v*` 标签后，GitHub Actions 会自动执行发布流程。

## 必须移动已有标签时

移动远端标签会重写历史，只有在确认该版本尚未正式交付且团队允许时才能执行。

先记录远端标签当前指向：

```bash
tag=v0.1.0
expected=$(git ls-remote origin "refs/tags/$tag" | cut -f1)
test -n "$expected"
```

将本地标签移动到当前提交：

```bash
git tag -f "$tag" HEAD
```

使用 `--force-with-lease` 安全更新远端标签：

```bash
git push --force-with-lease="refs/tags/$tag:$expected" origin "refs/tags/$tag"
```

确认远端结果：

```bash
git ls-remote origin "refs/tags/$tag"
```

`--force-with-lease` 比普通 `--force` 安全：如果远端标签在读取后被其他人修改，推送会被拒绝。

## 常见问题

### 标签与 package.json 版本不一致

错误示例：

```text
Tag v0.1.0 与 package.json 版本 v0.1.1 不一致
```

解决方式：

- 发布 `v0.1.0`：将 `package.json` 和 `package-lock.json` 版本统一为 `0.1.0`。
- 发布 `v0.1.1`：保持代码版本为 `0.1.1`，创建并推送 `v0.1.1`。

不要仅重新运行旧 workflow。旧运行仍然使用旧标签对应的提交，不会自动包含后续修复。

### Lint & Test 失败导致 Release 未创建

`release` job 依赖检查和构建任务。任何前置任务失败，后续发布都会被跳过。应先查看失败 job 的具体步骤，而不是只检查 Releases 页面。

修复后运行：

```bash
CI=true npm run lint
npm run typecheck
npm test
```

确认通过后，再使用新标签触发发布。

### 何时使用原生架构 runner

- CI 会启动并测试应用：应使用与目标应用相同架构的原生 runner。
- CI 只生成产物、不运行应用：在没有原生依赖的前提下，可以考虑交叉编译。
- 项目新增原生 Node.js 依赖后：应重新检查每个目标架构的依赖安装和打包行为。
