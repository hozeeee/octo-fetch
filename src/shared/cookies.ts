import type { Cookie, CookieChanges } from './model'
import { cookieSchema, urlSchema } from './model'

export function cookieKey(cookie: Cookie): string {
  const partition = typeof cookie.partitionKey === 'string'
    ? { sourceOrigin: cookie.partitionKey, hasCrossSiteAncestor: false }
    : cookie.partitionKey
  return JSON.stringify([cookie.name, cookie.domain.toLowerCase(), cookie.path,
    partition?.sourceOrigin || '', partition?.hasCrossSiteAncestor || false])
}

export function mergeCookies(base: Cookie[], changes: CookieChanges): Cookie[] {
  const map = new Map(base.map((cookie) => [cookieKey(cookie), cookie]))
  for (const cookie of changes.remove) map.delete(cookieKey(cookie))
  for (const cookie of changes.upsert) map.set(cookieKey(cookie), cookie)
  return [...map.values()]
}

export function diffCookies(before: Cookie[], after: Cookie[]): CookieChanges {
  const beforeMap = new Map(before.map((cookie) => [cookieKey(cookie), cookie]))
  const afterKeys = new Set(after.map(cookieKey))
  return {
    remove: before.filter((cookie) => !afterKeys.has(cookieKey(cookie))),
    upsert: after.filter((cookie) => JSON.stringify(beforeMap.get(cookieKey(cookie))) !== JSON.stringify(cookie))
  }
}

export function validateCookies(cookies: unknown[]): Cookie[] {
  if (cookies.length > 3000) throw new Error('一次最多配置 3000 个 Cookie')
  const seen = new Set<string>()
  return cookies.map((cookie, index) => {
    const result = cookieSchema.safeParse(cookie)
    if (!result.success) throw new Error(`第 ${index + 1} 项：${result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`)
    if (result.data.expires !== undefined && result.data.expires > 0 && result.data.expires < Date.now() / 1000) {
      throw new Error(`第 ${index + 1} 项：Cookie 已过期，请删除或更正 expires`)
    }
    const key = cookieKey(result.data)
    if (seen.has(key)) throw new Error(`第 ${index + 1} 项：名称、域、路径及分区重复`)
    seen.add(key)
    return result.data
  })
}

export function parseCookieText(text: string, format: 'json' | 'header', targetUrl: string): { cookies: Cookie[]; warnings: string[] } {
  const url = new URL(urlSchema.parse(targetUrl))
  if (text.length > 2_000_000) throw new Error('输入超过 2 MB 上限')
  if (format === 'header') {
    const cookies = text.split(';').map((item) => item.trim()).filter(Boolean).map((item) => {
      const separator = item.indexOf('=')
      if (separator < 1) throw new Error('每个 Cookie 都必须是 name=value 格式')
      return { name: item.slice(0, separator).trim(), value: item.slice(separator + 1).trim(), domain: url.hostname, path: '/', secure: url.protocol === 'https:' }
    })
    return { cookies: validateCookies(cookies), warnings: ['字符串仅按当前网址的主机和 / 路径导入，无法恢复 HttpOnly、SameSite、有效期和分区属性。'] }
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('JSON 语法错误，请粘贴 Cookie 数组') }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'cookies' in parsed) parsed = parsed.cookies
  if (!Array.isArray(parsed)) throw new Error('JSON 必须是 Cookie 数组或包含 cookies 数组的对象')
  const warnings = new Set<string>()
  const allowed = new Set(['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite', 'priority', 'sourceScheme', 'partitionKey'])
  const metadata = new Set(['size', 'session', 'hostOnly', 'storeId', 'id'])
  const cookies = parsed.map((item: unknown, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`第 ${index + 1} 项不是对象`)
    const source = item as Record<string, unknown>
    const result: Record<string, unknown> = { domain: url.hostname, path: '/' }
    for (const [key, value] of Object.entries(source)) {
      if (allowed.has(key)) result[key] = value
      else if (key === 'expirationDate') result.expires = value
      else if (key === 'sameParty' && value === false) warnings.add('当前 Chrome 已移除 SameParty，已忽略旧导出中的 false 值。')
      else if (metadata.has(key)) warnings.add('已识别浏览器导出的只读元数据；session/hostOnly 按有效期和域规则转换，size/storeId/id 不会写入浏览器。')
      else throw new Error(`第 ${index + 1} 项包含不支持的属性：${key}`)
    }
    if (source.session === true) delete result.expires
    if (typeof result.domain === 'string') {
      let domain = result.domain.toLowerCase()
      if (source.hostOnly === true) domain = domain.replace(/^\./, '')
      else if (source.hostOnly === false && !domain.startsWith('.')) domain = `.${domain}`
      result.domain = domain
    }
    if (typeof result.sameSite === 'string') {
      const values: Record<string, string | undefined> = { strict: 'Strict', lax: 'Lax', no_restriction: 'None', unspecified: undefined }
      if (result.sameSite in values) result.sameSite = values[result.sameSite]
    }
    return result
  })
  return { cookies: validateCookies(cookies), warnings: [...warnings] }
}
