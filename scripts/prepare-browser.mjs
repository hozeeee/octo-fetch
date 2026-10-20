import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Browser, BrowserPlatform, computeExecutablePath, install } from '@puppeteer/browsers'
import { PUPPETEER_REVISIONS } from 'puppeteer-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arch = process.argv.includes('--x64') ? 'x64' : process.argv.includes('--arm64') ? 'arm64' : process.arch
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) {
  throw new Error('浏览器准备脚本仅支持 macOS arm64 / x64。')
}
const cacheDir = path.join(root, '.browsers', arch)
const platform = arch === 'arm64' ? BrowserPlatform.MAC_ARM : BrowserPlatform.MAC
const buildId = PUPPETEER_REVISIONS.chrome
let previous = -1
await install({
  browser: Browser.CHROME, buildId, cacheDir, platform,
  downloadProgressCallback(downloaded, total) {
    const progress = Math.floor(downloaded / total * 10) * 10
    if (progress !== previous) { previous = progress; console.log(`Chrome ${buildId} (${arch}): ${progress}%`) }
  }
})
const executable = computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir, platform })
await access(executable)
await mkdir(cacheDir, { recursive: true })
await writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify({
  arch, buildId, executable: path.relative(cacheDir, executable)
}, null, 2))
console.log(`浏览器已就绪：${buildId} (${arch})`)
