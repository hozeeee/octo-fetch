import { VIEWPORT } from './model'

export function mapPoint(rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number, clamp = false, viewport: { width: number; height: number } = VIEWPORT, image: { width: number; height: number } = viewport): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  if (viewport.width <= 0 || viewport.height <= 0 || image.width <= 0 || image.height <= 0) return null
  const scale = Math.min(rect.width / image.width, rect.height / image.height)
  const x = (clientX - rect.left - (rect.width - image.width * scale) / 2) / (scale * image.width) * viewport.width
  const y = (clientY - rect.top - (rect.height - image.height * scale) / 2) / (scale * image.height) * viewport.height
  if (!clamp && (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height)) return null
  return { x: Math.max(0, Math.min(viewport.width - 1, x)), y: Math.max(0, Math.min(viewport.height - 1, y)) }
}
