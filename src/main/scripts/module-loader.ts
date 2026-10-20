import { createRequire } from 'node:module'
import path from 'node:path'

function moduleName(specifier: unknown): string {
  if (typeof specifier !== 'string' || !specifier) throw new Error('模块名称无效')
  return specifier
}

export function createScriptModuleLoader(root: string) {
  const filename = path.join(root, 'script.js')
  const nativeRequire = createRequire(filename)
  return {
    filename,
    require(specifier: unknown): unknown {
      return nativeRequire(moduleName(specifier))
    }
  }
}
