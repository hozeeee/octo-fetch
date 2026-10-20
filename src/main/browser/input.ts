import type { CDPSession, KeyInput, MouseButton, Page } from 'puppeteer-core'
import type { RemoteInput } from '../../shared/model'
import { clipboard } from 'electron'
import { SerialQueue } from '../storage/store'
import { pageGeometry, validatePoint, withPageOperation } from './options'

const SPECIAL_KEYS = new Set(['Backspace', 'Tab', 'Enter', 'Escape', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Shift', 'Control', 'Alt', 'Meta', 'Space', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)])
export class PageInput {
  private keys = new Set<KeyInput>()
  private buttons = new Set<MouseButton>()
  private queue = new SerialQueue()
  private waiting = 0
  private enabled = true
  private session?: CDPSession
  private position = { x: 0, y: 0 }
  private touching = false
  constructor(private page: Page, private touch = false) {}
  run(input: RemoteInput): Promise<void> {
    if (!this.enabled && input.type !== 'release') return Promise.resolve()
    if (this.waiting > 128 && input.type !== 'release') return Promise.reject(new Error('输入过快，请稍后重试'))
    this.waiting++
    return this.queue.run(() => withPageOperation(this.page, async () => {
      if ((!this.enabled && input.type !== 'release') || this.page.isClosed()) return
      switch (input.type) {
        case 'move': case 'down': case 'up': case 'wheel': {
          this.session ||= await this.page.createCDPSession()
          const geometry = await pageGeometry(this.page, this.session)
          validatePoint(input, geometry)
          this.position = { x: input.x + geometry.offsetX, y: input.y + geometry.offsetY }
          if (this.touch && input.type !== 'wheel' && (input.type === 'move' || input.button === 'left')) {
            if (input.type === 'down') this.touching = true
            if (this.touching) await this.session.send('Input.dispatchTouchEvent', { type: input.type === 'down' ? 'touchStart' : input.type === 'up' ? 'touchEnd' : 'touchMove', touchPoints: input.type === 'up' ? [] : [{ ...this.position, id: 0 }] })
            if (input.type === 'up') this.touching = false
            break
          }
          if (input.type === 'down') this.buttons.add(input.button)
          if (input.type === 'up') this.buttons.delete(input.button)
          await this.session.send('Input.dispatchMouseEvent', {
            type: input.type === 'down' ? 'mousePressed' : input.type === 'up' ? 'mouseReleased' : input.type === 'wheel' ? 'mouseWheel' : 'mouseMoved',
            ...this.position,
            button: 'button' in input ? input.button : 'none',
            buttons: (this.buttons.has('left') ? 1 : 0) | (this.buttons.has('right') ? 2 : 0) | (this.buttons.has('middle') ? 4 : 0),
            modifiers: (this.keys.has('Alt') ? 1 : 0) | (this.keys.has('Control') ? 2 : 0) | (this.keys.has('Meta') ? 4 : 0) | (this.keys.has('Shift') ? 8 : 0),
            clickCount: 'clickCount' in input ? input.clickCount : 0,
            ...(input.type === 'wheel' ? { deltaX: input.deltaX, deltaY: input.deltaY } : {})
          })
          break
        }
        case 'keyDown': case 'keyUp': {
          if (!SPECIAL_KEYS.has(input.key) && !/^[\w .,/;:'"[\]\\=+\-`~!?@#$%^&*(){}<>|]$/.test(input.key)) throw new Error('暂不支持此按键')
          const key = input.key as KeyInput
          if (input.type === 'keyDown') { this.keys.add(key); await this.page.keyboard.down(key) } else { await this.page.keyboard.up(key); this.keys.delete(key) }
          break
        }
        case 'text': await this.page.keyboard.sendCharacter(input.text); break
        case 'paste': await this.page.keyboard.sendCharacter((await clipboard.readText()).slice(0, 100000)); break
        case 'copy': await this.copy(); break
        case 'selectAll': {
          const session = await this.page.createCDPSession()
          try { await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', commands: ['selectAll'] }) } finally { await session.detach() }
          break
        }
        case 'release': await this.releaseNow(); break
      }
    })).finally(() => { this.waiting-- })
  }
  private async copy(): Promise<void> {
    for (const frame of this.page.frames()) {
      const result = await frame.evaluate(() => {
        if (!document.hasFocus()) return null
        const active = document.activeElement
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
          if (active instanceof HTMLInputElement && active.type === 'password') return null
          if (active.selectionStart === null || active.selectionEnd === null) return null
          return active.value.slice(active.selectionStart, active.selectionEnd).slice(0, 100000)
        }
        return window.getSelection()?.toString().slice(0, 100000) || null
      }).catch(() => null)
      if (result !== null) { await clipboard.writeText(result); return }
    }
  }
  private async releaseNow(): Promise<void> {
    for (const key of this.keys) await this.page.keyboard.up(key).catch(() => undefined)
    for (const button of this.buttons) await this.session?.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...this.position, button, buttons: 0, clickCount: 1 }).catch(() => undefined)
    if (this.touching) await this.session?.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(() => undefined)
    this.touching = false
    this.keys.clear(); this.buttons.clear()
  }
  async deactivate(): Promise<void> { this.enabled = false; await this.run({ type: 'release' }) }
  activate(): void { this.enabled = true }
  async dispose(): Promise<void> {
    await this.deactivate().catch(() => undefined)
    await this.session?.detach().catch(() => undefined)
    this.session = undefined; this.touching = false; this.keys.clear(); this.buttons.clear()
  }
}
