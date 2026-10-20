import { spawnSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Arch, build, Platform } from 'electron-builder'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arch = process.argv.includes('--x64') ? 'x64' : process.argv.includes('--arm64') ? 'arm64' : process.arch
const prepared = spawnSync(process.execPath, [path.join(root, 'scripts/prepare-browser.mjs'), `--${arch}`], { stdio: 'inherit' })
if (prepared.status !== 0) process.exit(prepared.status || 1)
const cache = path.join(root, '.browsers', arch)
const manifest = JSON.parse(await readFile(path.join(cache, 'manifest.json'), 'utf8'))
await access(path.join(cache, manifest.executable))
const notarize = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)
await build({
  projectDir: root,
  targets: Platform.MAC.createTarget(process.argv.includes('--dir') ? ['dir'] : ['dmg', 'zip'], arch === 'arm64' ? Arch.arm64 : Arch.x64),
  config: {
    appId: 'app.octofetch.desktop', productName: 'Octo Fetch',
    directories: { output: 'dist' },
    files: ['out/**/*', 'package.json'],
    asar: true,
    electronDist: process.env.OCTO_ELECTRON_DIST || undefined,
    extraResources: [{ from: cache, to: 'browser', filter: ['**/*'] }],
    mac: {
      category: 'public.app-category.developer-tools',
      identity: process.env.CSC_LINK || process.env.CSC_NAME ? undefined : null,
      hardenedRuntime: true,
      notarize,
      minimumSystemVersion: '13.0',
      // eslint-disable-next-line no-template-curly-in-string -- electron-builder 的文件名宏，不是模板字符串。
      artifactName: '${productName}-${version}-${arch}.${ext}'
    }
  }
})
