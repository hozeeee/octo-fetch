import type { Command, DesktopAPI, Frame, Snapshot } from '../../shared/model'
import { App } from 'antd'
import { useCallback } from 'react'
import { create } from 'zustand'

declare global { interface Window { octo: DesktopAPI } }
type View = 'workspace' | 'sites' | 'scripts' | 'tasks' | 'notifications' | 'data' | 'mcp' | 'settings' | 'capture'
export const useDesktop = create<{
  snapshot?: Snapshot; frames: Record<string, Frame>; view: View; focus: string | null; error?: string
  setView(view: View): void; setFocus(id: string | null): void
}>((set) => ({
  frames: {}, view: 'workspace', focus: null,
  setView: (view) => set({ view, focus: null }),
  setFocus: (focus) => set({ focus, view: 'workspace' })
}))
export function connectDesktop(): () => void {
  if (!window.octo) { useDesktop.setState({ error: '请在 Electron 桌面应用中打开此界面，浏览器预览无法控制本地网站。' }); return () => undefined }
  const accept = (snapshot: Snapshot) => {
    const current = useDesktop.getState()
    const ids = new Set(snapshot.config.sites.map((site) => site.id))
    useDesktop.setState({ snapshot, frames: Object.fromEntries(Object.entries(current.frames).filter(([id]) => ids.has(id))), focus: current.focus && ids.has(current.focus) ? current.focus : null })
  }
  const offState = window.octo.onState(accept)
  const offFrame = window.octo.onFrame((frame) => {
    const previous = useDesktop.getState().frames[frame.siteId]
    if (!previous || frame.sequence > previous.sequence) useDesktop.setState((state) => ({ frames: { ...state.frames, [frame.siteId]: frame } }))
    const { siteId, generation, tabId, sequence } = frame
    window.octo.acknowledge({ siteId, generation, tabId, sequence })
  })
  void window.octo.snapshot().then((reply) => {
    if (reply.ok) accept(reply.data)
    else useDesktop.setState({ error: reply.error })
  }).catch(() => useDesktop.setState({ error: '无法连接桌面服务，请重新启动应用' }))
  return () => { offState(); offFrame() }
}
export function useCommand() {
  const { message } = App.useApp()
  return useCallback(async (command: Command): Promise<boolean> => {
    try {
      const result = await window.octo.command(command)
      if (!result.ok) { void message.error({ content: result.error, key: 'command-error' }); return false }
      return true
    } catch { void message.error({ content: '桌面服务暂时不可用', key: 'command-error' }); return false }
  }, [message])
}
