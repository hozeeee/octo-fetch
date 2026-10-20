// 自实现 5 段 cron（分 时 日 月 周），仅支持 * , - */n a-b/n，基于本机时区、分钟粒度。
// 不引入第三方依赖，契合项目零依赖风格；只覆盖调度所需的常用语法。
type Field = { values: Set<number>; star: boolean }
type Parsed = { minute: Field; hour: Field; dom: Field; month: Field; dow: Field }
const BOUNDS = [
  { min: 0, max: 59, label: '分钟' }, { min: 0, max: 23, label: '小时' },
  { min: 1, max: 31, label: '日' }, { min: 1, max: 12, label: '月' }, { min: 0, max: 6, label: '星期' }
] as const

function parseField(raw: string, min: number, max: number, label: string): Field {
  const values = new Set<number>()
  const star = raw === '*' || /^\*\/\d+$/.test(raw)
  for (const part of raw.split(',')) {
    if (!part) throw new Error(`${label}字段为空`)
    const [range, stepText] = part.split('/')
    if (part.includes('/') && !stepText) throw new Error(`${label}步长缺失`)
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`${label}步长无效`)
    let from: number, to: number
    if (range === '*') { from = min; to = max } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      from = Number(a); to = Number(b)
      if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error(`${label}范围无效`)
    } else {
      from = to = Number(range)
      if (!Number.isInteger(from)) throw new Error(`${label}取值无效`)
      if (stepText !== undefined) to = max
    }
    if (from < min || to > max || from > to) throw new Error(`${label}应在 ${min}-${max} 之间`)
    for (let value = from; value <= to; value += step) values.add(value)
  }
  if (!values.size) throw new Error(`${label}字段无有效取值`)
  return { values, star }
}

function parse(expr: string): Parsed {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('cron 需要 5 段：分 时 日 月 周')
  const [minute, hour, dom, month, dow] = parts.map((part, index) => parseField(part, BOUNDS[index].min, BOUNDS[index].max, BOUNDS[index].label))
  return { minute, hour, dom, month, dow }
}

export function validateCron(expr: string): string | undefined {
  try { parse(expr); return undefined } catch (error) { return error instanceof Error ? error.message : 'cron 表达式无效' }
}

// 日期匹配遵循 Vixie cron：日与星期都受限时任一命中即可，否则要求二者同时满足。
function dayMatches(parsed: Parsed, date: Date): boolean {
  if (!parsed.month.values.has(date.getMonth() + 1)) return false
  const domHit = parsed.dom.values.has(date.getDate())
  const dowHit = parsed.dow.values.has(date.getDay())
  if (!parsed.dom.star && !parsed.dow.star) return domHit || dowHit
  return domHit && dowHit
}

export function cronMatches(expr: string, date: Date): boolean {
  let parsed: Parsed
  try { parsed = parse(expr) } catch { return false }
  return dayMatches(parsed, date) && parsed.hour.values.has(date.getHours()) && parsed.minute.values.has(date.getMinutes())
}

// 返回严格晚于 from 的下一个匹配时刻；最多向前查约 367 天，找不到返回 undefined。
export function cronNext(expr: string, from: Date): Date | undefined {
  let parsed: Parsed
  try { parsed = parse(expr) } catch { return undefined }
  const date = new Date(from)
  date.setSeconds(0, 0)
  date.setMinutes(date.getMinutes() + 1)
  const limit = new Date(from.getTime() + 367 * 24 * 60 * 60 * 1000)
  // eslint-disable-next-line no-unmodified-loop-condition -- date 通过 setHours/setMinutes 等方法原地推进。
  while (date <= limit) {
    if (!dayMatches(parsed, date)) { date.setHours(0, 0, 0, 0); date.setDate(date.getDate() + 1); continue }
    if (parsed.hour.values.has(date.getHours()) && parsed.minute.values.has(date.getMinutes())) return new Date(date)
    date.setMinutes(date.getMinutes() + 1)
  }
  return undefined
}
