import type { InstallResult, SavedScript, ScriptDependency, ScriptKind } from '../../shared/scripts'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { atomicWrite } from '../storage/store'

const INSTALL_TIMEOUT = 5 * 60 * 1000
const MAX_INSTALL_LOG = 64 * 1024
const INSTALL_STATE_FILE = '.octo-dependencies.json'

export type PackageInstaller = (cwd: string, dependencies: ScriptDependency[], registry: string, signal: AbortSignal) => Promise<InstallResult>

export function scriptPackageDirectory(root: string, id: string, kind: ScriptKind): string {
  return path.join(root, kind === 'sandbox' ? 'sandbox-data' : 'script-data', id)
}

function dependencyFingerprint(dependencies: ScriptDependency[]): string {
  const normalized = [...dependencies].sort((left, right) => left.name.localeCompare(right.name))
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

export async function clearDependencyInstallation(cwd: string): Promise<void> {
  await atomicWrite(path.join(cwd, INSTALL_STATE_FILE), `${JSON.stringify({ version: 1, fingerprint: null }, null, 2)}\n`)
}

export async function markDependenciesInstalled(cwd: string, dependencies: ScriptDependency[]): Promise<void> {
  await atomicWrite(path.join(cwd, INSTALL_STATE_FILE), `${JSON.stringify({ version: 1, fingerprint: dependencyFingerprint(dependencies) }, null, 2)}\n`)
}

export async function dependenciesInstalled(cwd: string, dependencies: ScriptDependency[]): Promise<boolean> {
  if (!dependencies.length) return true
  try {
    const state = JSON.parse(await readFile(path.join(cwd, INSTALL_STATE_FILE), 'utf8')) as { version?: unknown; fingerprint?: unknown }
    if (state.version !== 1 || state.fingerprint !== dependencyFingerprint(dependencies)) return false
    await access(path.join(cwd, 'node_modules'))
    await Promise.all(dependencies.map(({ name }) => access(path.join(cwd, 'node_modules', ...name.split('/'), 'package.json'))))
    return true
  } catch { return false }
}

function appendLog(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString()
  const marker = '…已省略前部日志…\n'
  return next.length <= MAX_INSTALL_LOG ? next : `${marker}${next.slice(-(MAX_INSTALL_LOG - marker.length))}`
}

export const installPackages: PackageInstaller = async (cwd, dependencies, registry, signal) => {
  const manifest = {
    name: 'octo-fetch-script',
    version: '1.0.0',
    private: true,
    dependencies: Object.fromEntries(dependencies.map(({ name, version }) => [name, version]))
  }
  await atomicWrite(path.join(cwd, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  return new Promise<InstallResult>((resolve) => {
    const controller = new AbortController()
    let logs = '', settled = false, timedOut = false
    const finish = (result: InstallResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      resolve(result)
    }
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) controller.abort()
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, INSTALL_TIMEOUT)
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=info'], {
      cwd, shell: false, signal: controller.signal, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot'].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
        NPM_CONFIG_REGISTRY: registry, NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_IGNORE_SCRIPTS: 'true'
      }
    })
    child.stdout.on('data', (chunk: Buffer) => { logs = appendLog(logs, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { logs = appendLog(logs, chunk) })
    child.on('error', (error) => {
      const cancelled = signal.aborted || timedOut
      finish({ ok: false, logs, error: timedOut ? '依赖安装超过 5 分钟，已终止' : cancelled ? '依赖安装已取消' : `无法启动 npm：${error.message}` })
    })
    child.on('close', (code) => {
      if (timedOut) finish({ ok: false, logs, error: '依赖安装超过 5 分钟，已终止' })
      else if (signal.aborted) finish({ ok: false, logs, error: '依赖安装已取消' })
      else if (code === 0) finish({ ok: true, logs })
      else finish({ ok: false, logs, error: `npm install 失败（退出码 ${code ?? '未知'}）` })
    })
  })
}

export class ScriptPackageService {
  private installations = new Map<string, { controller: AbortController; promise: Promise<InstallResult> }>()
  private closing = false

  constructor(private root: string, private installer: PackageInstaller = installPackages) {}

  directory(saved: Pick<SavedScript, 'id' | 'draft'>): string {
    return scriptPackageDirectory(this.root, saved.id, saved.draft.kind)
  }

  isInstalling(id: string): boolean {
    return this.installations.has(id)
  }

  async install(saved: SavedScript, registry: string): Promise<InstallResult> {
    if (this.closing) throw new Error('应用正在退出')
    if (this.installations.has(saved.id)) throw new Error('该脚本正在安装依赖')
    const controller = new AbortController()
    const cwd = this.directory(saved)
    const dependencies = saved.draft.dependencies
    const promise = Promise.resolve().then(async () => {
      await mkdir(cwd, { recursive: true })
      await clearDependencyInstallation(cwd)
      const result = await this.installer(cwd, dependencies, registry, controller.signal)
      if (!result.ok) return result
      try {
        await markDependenciesInstalled(cwd, dependencies)
        return result
      } catch (error) {
        return { ok: false, logs: result.logs, error: `依赖已安装，但无法保存安装状态：${String(error)}` }
      }
    })
    this.installations.set(saved.id, { controller, promise })
    try { return await promise } finally { if (this.installations.get(saved.id)?.promise === promise) this.installations.delete(saved.id) }
  }

  async shutdown(): Promise<void> {
    this.closing = true
    for (const installation of this.installations.values()) installation.controller.abort()
    await Promise.allSettled([...this.installations.values()].map((installation) => installation.promise))
  }
}
