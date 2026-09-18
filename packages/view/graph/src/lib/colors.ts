// ─── Session colour scale helpers ─────────────────────────────────────────────

export function sesT(count: number, minCount: number, maxCount: number): number {
  return maxCount === minCount ? 0.5 : (count - minCount) / (maxCount - minCount)
}

export function sesSize(count: number, minCount: number, maxCount: number): number {
  return 29 + sesT(count, minCount, maxCount) * 7
}

export function lerpHex(a: string, b: string, t: number): string {
  const ar = parseInt(a.slice(1, 3), 16), ag = parseInt(a.slice(3, 5), 16), ab = parseInt(a.slice(5, 7), 16)
  const br = parseInt(b.slice(1, 3), 16), bg = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16)
  const r  = Math.round(ar + t * (br - ar))
  const g  = Math.round(ag + t * (bg - ag))
  const bl = Math.round(ab + t * (bb - ab))
  return '#' + (r < 16 ? '0' : '') + r.toString(16)
       + (g < 16 ? '0' : '') + g.toString(16)
       + (bl < 16 ? '0' : '') + bl.toString(16)
}

export function sesBg(count: number, minCount: number, maxCount: number): string {
  return lerpHex('#B8CEB0', '#1A3C22', sesT(count, minCount, maxCount))
}

export function sesBorder(count: number, minCount: number, maxCount: number): string {
  return lerpHex('#8AAE82', '#0E2214', sesT(count, minCount, maxCount))
}

export function agentBg(count: number, minCount: number, maxCount: number): string {
  return lerpHex('#A8B8D0', '#1A2A3C', sesT(count, minCount, maxCount))
}

export function agentBorder(count: number, minCount: number, maxCount: number): string {
  return lerpHex('#7898B8', '#0E1A28', sesT(count, minCount, maxCount))
}
