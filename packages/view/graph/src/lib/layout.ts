// ─── Layout constants (mirrored from graph-html.ts) ───────────────────────────
const PROMPT_COLS   = 3
const PROMPT_COL_W  = 32
const PROMPT_ROW_H  = 30
const PROMPT_OFFSET = 54

// ─── Prompt grid positions (browser-side, needed for agent sessions) ──────────
// Mirrors the TypeScript promptGridPositions() function from graph-html.ts.
export function computePromptGrid(
  sx: number,
  sy: number,
  dayX: number,
  count: number,
): Array<{ gx: number; gy: number }> {
  const dx = sx - dayX, dy = sy
  const len = Math.sqrt(dx * dx + dy * dy) || 1
  const ox = dx / len, oy = dy / len
  const lx = -oy,     ly = ox

  const cols   = Math.min(count, PROMPT_COLS)
  const totalW = (cols - 1) * PROMPT_COL_W

  const pts: Array<{ gx: number; gy: number }> = []
  for (let pi = 0; pi < count; pi++) {
    const col     = pi % PROMPT_COLS
    const row     = Math.floor(pi / PROMPT_COLS)
    const outward = PROMPT_OFFSET + row * PROMPT_ROW_H
    const lateral = -totalW / 2 + col * PROMPT_COL_W
    pts.push({
      gx: sx + ox * outward + lx * lateral,
      gy: sy + oy * outward + ly * lateral,
    })
  }
  return pts
}
