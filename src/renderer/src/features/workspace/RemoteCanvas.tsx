import type { KeyboardEvent, PointerEvent } from 'react'
import type { RemoteInput, Runtime } from '../../../../shared/model'
import { DesktopOutlined } from '@ant-design/icons'
import { Spin } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { mapPoint } from '../../../../shared/coordinates'
import { VIEWPORT } from '../../../../shared/model'
import { useCommand, useDesktop } from '../../store'

export function RemoteCanvas({ runtime, siteId, interactive = false }: { runtime?: Runtime; siteId: string; interactive?: boolean }) {
  const frame = useDesktop((state) => state.frames[siteId])
  const command = useCommand()
  const canvas = useRef<HTMLCanvasElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const lastMove = useRef(0)
  const down = useRef(false)
  const clicks = useRef({ at: 0, x: 0, y: 0, count: 0 })
  const [focused, setFocused] = useState(false)
  const [paintedTarget, setPaintedTarget] = useState('')
  const currentTarget = `${runtime?.generation}:${runtime?.activeTabId}`
  const validFrame = frame && frame.generation === runtime?.generation && frame.tabId === runtime?.activeTabId
  const ready = validFrame && paintedTarget === currentTarget
  const usable = interactive && runtime?.status === 'running' && Boolean(runtime.activeTabId)
  const viewport = runtime?.viewport ?? VIEWPORT
  const displayed = useRef<{ geometry: { width: number; height: number }; image: { width: number; height: number }; ready: boolean }>({ geometry: viewport, image: viewport, ready: false })
  const tabId = runtime?.activeTabId
  const generation = runtime?.generation
  const send = useCallback((event: RemoteInput) => {
    if (!tabId || !generation) return
    void command({ type: 'input', siteId, tabId, generation, input: event })
  }, [siteId, tabId, generation, command])
  useEffect(() => {
    const context = canvas.current?.getContext('2d')
    if (!context) return
    if (!validFrame) { displayed.current.ready = false; context.clearRect(0, 0, canvas.current!.width, canvas.current!.height); return }
    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (cancelled || !canvas.current) return
      canvas.current.width = image.naturalWidth; canvas.current.height = image.naturalHeight
      context.drawImage(image, 0, 0)
      displayed.current = { geometry: frame.geometry ?? runtime?.viewport ?? VIEWPORT, image: { width: image.naturalWidth, height: image.naturalHeight }, ready: true }
      setPaintedTarget(currentTarget)
    }
    image.src = `data:image/jpeg;base64,${frame.data}`
    return () => { cancelled = true; image.onload = null }
  }, [frame, validFrame, runtime?.viewport, currentTarget])
  useEffect(() => {
    if (!usable) return
    const release = () => { down.current = false; composing.current = false; send({ type: 'release' }); setFocused(false) }
    window.addEventListener('blur', release)
    return () => { window.removeEventListener('blur', release); release() }
  }, [usable, send])
  useEffect(() => {
    const element = stage.current
    if (!element || !usable) return
    const wheel = (event: WheelEvent) => {
      if (!displayed.current.ready) return
      const point = mapPoint(element.getBoundingClientRect(), event.clientX, event.clientY, false, displayed.current.geometry, displayed.current.image)
      if (!point) return
      event.preventDefault()
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? displayed.current.geometry.height : 1
      send({ type: 'wheel', ...point, deltaX: Math.max(-10000, Math.min(10000, event.deltaX * factor)), deltaY: Math.max(-10000, Math.min(10000, event.deltaY * factor)) })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [usable, send])
  const pointer = (event: PointerEvent<HTMLDivElement>, type: 'down' | 'up' | 'move') => {
    if (!usable || !stage.current || !displayed.current.ready) return
    const rect = stage.current.getBoundingClientRect()
    const point = mapPoint(rect, event.clientX, event.clientY, down.current, displayed.current.geometry, displayed.current.image)
    if (!point) return
    if (type === 'move') {
      if (performance.now() - lastMove.current < 25) return
      lastMove.current = performance.now(); send({ type: 'move', ...point }); return
    }
    event.preventDefault()
    const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left'
    if (type === 'down') {
      stage.current.setPointerCapture(event.pointerId); down.current = true
      if (input.current) { input.current.style.left = `${event.clientX - rect.left}px`; input.current.style.top = `${event.clientY - rect.top}px`; input.current.focus({ preventScroll: true }) }
      const old = clicks.current
      clicks.current = { ...point, at: performance.now(), count: performance.now() - old.at < 450 && Math.hypot(old.x - point.x, old.y - point.y) < 5 ? Math.min(3, old.count + 1) : 1 }
    } else {
      down.current = false
      if (stage.current.hasPointerCapture(event.pointerId)) stage.current.releasePointerCapture(event.pointerId)
    }
    send({ type, ...point, button, clickCount: clicks.current.count || 1 })
  }
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || composing.current || event.key === 'Process' || event.key === 'Dead') return
    if (event.metaKey || event.ctrlKey) {
      const shortcut = event.key.toLowerCase()
      if (['c', 'v', 'a'].includes(shortcut)) {
        event.preventDefault(); send({ type: shortcut === 'c' ? 'copy' : shortcut === 'v' ? 'paste' : 'selectAll' }); return
      }
      if (['q', 'w', 'h', 'm'].includes(shortcut)) return
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) return
    event.preventDefault()
    send({ type: 'keyDown', key: event.key === ' ' ? 'Space' : event.key })
  }
  const keyUp = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing) return
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) return
    if ((event.metaKey || event.ctrlKey) && ['c', 'v', 'a', 'q', 'w', 'h', 'm'].includes(event.key.toLowerCase())) return
    event.preventDefault(); send({ type: 'keyUp', key: event.key === ' ' ? 'Space' : event.key })
  }
  const commitText = () => {
    if (input.current?.value) { send({ type: 'text', text: input.current.value }); input.current.value = '' }
  }
  return <div ref={stage} className={`remote-stage ${interactive ? 'interactive' : ''} ${focused ? 'input-focused' : ''}`}
    onPointerDown={(event) => pointer(event, 'down')} onPointerUp={(event) => pointer(event, 'up')} onPointerMove={(event) => pointer(event, 'move')}
    onPointerCancel={() => { down.current = false; send({ type: 'release' }) }} onContextMenu={(event) => event.preventDefault()}>
    <canvas ref={canvas} width={viewport.width} height={viewport.height} aria-label="网站实时画面" aria-busy={!ready} data-site-id={siteId} data-tab-id={tabId} />
    {!ready && <div className="frame-placeholder">{runtime?.status === 'starting' || runtime?.status === 'running' ? <Spin /> : <DesktopOutlined />}<span>{runtime?.status === 'starting' ? '正在启动独立浏览器…' : runtime?.status === 'running' ? '等待网站画面…' : '网站尚未启动'}</span></div>}
    {usable && <textarea ref={input} className="input-proxy" aria-label="网页键盘输入" autoCapitalize="off" autoComplete="off" spellCheck={false}
      onKeyDown={keyDown} onKeyUp={keyUp} onFocus={() => setFocused(true)} onBlur={() => { composing.current = false; setFocused(false); send({ type: 'release' }) }}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; commitText() }} onInput={() => { if (!composing.current) commitText() }}
      onPaste={(event) => { event.preventDefault(); send({ type: 'text', text: event.clipboardData.getData('text/plain').slice(0, 100000) }) }} onCopy={(event) => { event.preventDefault(); send({ type: 'copy' }) }} />}
  </div>
}
