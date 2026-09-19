import { readFileSync } from "node:fs"
import * as path from "node:path"
import type { GraphSessionEntry, GraphPromptEntry, GraphToolCall } from "../component/history-graph"
// Embedded at build time so the compiled binary doesn't need the file on disk.
// @ts-ignore — Bun text loader (import attributes)
import _distHtml from '../../../graph/dist/index.html' with { type: 'text' }
const DIST_HTML = _distHtml as string

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtDateTime(raw?: number): string {
  if (!raw) return ""
  const ms = raw > 1e13 ? Math.floor(raw / 1000) : raw
  if (ms <= 0) return ""
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function catGifSrc(): string {
  try {
    return "data:image/gif;base64," + readFileSync(path.join(import.meta.dir, "../../../../../assets/landing_cat.gif")).toString("base64")
  } catch { return "" }
}

// ─── Layout constants ─────────────────────────────────────────────────────────
const WIFI_BASE_R      = 120
const MIN_NODE_SPACING = 52
const DAY_GAP          = 70
const SESSION_NODE_R   = 20
const PROMPT_COLS      = 3
const PROMPT_COL_W     = 32
const PROMPT_ROW_H     = 30
const PROMPT_OFFSET    = 54

// ─── Types ────────────────────────────────────────────────────────────────────
type ToolCall = GraphToolCall
type PromptEntry = GraphPromptEntry

interface SessionSummary {
  id: string
  title: string
  firstPrompt?: PromptEntry
  time: number
  prompts: PromptEntry[]
  parentId?: string
}

interface DayGroup {
  label: string
  time?: number
  sessions: SessionSummary[]
}

// ─── Layout helpers ───────────────────────────────────────────────────────────
function orbitR(count: number): number {
  if (count <= 1) return WIFI_BASE_R
  const minR = MIN_NODE_SPACING / (2 * Math.sin(Math.PI / count))
  return Math.max(WIFI_BASE_R, minR)
}

function dayXExtent(count: number): number {
  return orbitR(count) + SESSION_NODE_R
}

function wifiPos(sesIdx: number, total: number, dayX: number): { x: number; y: number } {
  const R     = orbitR(total)
  const angle = -Math.PI / 2 + (2 * Math.PI * sesIdx) / Math.max(total, 1)
  return { x: dayX + R * Math.cos(angle), y: R * Math.sin(angle) }
}

function promptGridPositions(
  sx: number, sy: number, dayX: number, count: number,
): Array<{ gx: number; gy: number }> {
  const dx = sx - dayX, dy = sy
  const len = Math.sqrt(dx * dx + dy * dy) || 1
  const ox = dx / len, oy = dy / len
  const lx = -oy, ly = ox

  const cols   = Math.min(count, PROMPT_COLS)
  const totalW = (cols - 1) * PROMPT_COL_W

  return Array.from({ length: count }, (_, pi) => {
    const col    = pi % PROMPT_COLS
    const row    = Math.floor(pi / PROMPT_COLS)
    const outward = PROMPT_OFFSET + row * PROMPT_ROW_H
    const lateral = -totalW / 2 + col * PROMPT_COL_W
    return {
      gx: sx + ox * outward + lx * lateral,
      gy: sy + oy * outward + ly * lateral,
    }
  })
}

// ─── Group sessions by calendar day ──────────────────────────────────────────
function groupSessionsByDay(sessions: GraphSessionEntry[]): DayGroup[] {
  const map = new Map<string, DayGroup>()
  const sorted = [...sessions].sort((a, b) => a.timeCreated - b.timeCreated)
  for (const s of sorted) {
    const createdMs = s.timeCreated > 1e13 ? Math.floor(s.timeCreated / 1000) : s.timeCreated
    if (!createdMs) continue
    const date  = new Date(createdMs)
    const key   = date.toDateString()
    const label = date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
    if (!map.has(key)) map.set(key, { label, time: createdMs, sessions: [] })
    const [first, ...rest] = s.prompts
    map.get(key)!.sessions.push({
      id:          s.id,
      title:       s.title,
      time:        createdMs,
      firstPrompt: first,
      prompts:     rest,
      parentId:    s.parentId,
    })
  }
  return Array.from(map.values())
}

// ─── Build Cytoscape elements ─────────────────────────────────────────────────
function buildElements(days: DayGroup[]): object[] {
  const els: object[] = []
  const sessionNodeMap = new Map<string, string[]>()

  const dayXs: number[] = []
  for (let di = 0; di < days.length; di++) {
    if (di === 0) { dayXs.push(0); continue }
    const prevRight = dayXExtent(days[di - 1]!.sessions.length)
    const currLeft  = dayXExtent(days[di]!.sessions.length)
    dayXs.push(dayXs[di - 1]! + prevRight + currLeft + DAY_GAP)
  }

  for (let di = 0; di < days.length; di++) {
    const day  = days[di]!
    const dayID = `d${di}`
    const dayX  = dayXs[di]!

    els.push({
      data: {
        id: dayID, type: "day",
        label: day.label,
        sessionCount: day.sessions.length,
        time: fmtDateTime(day.time),
        dayIdx: di,
        dayX,
      },
      position: { x: dayX, y: 0 },
    })

    if (di > 0) els.push({ data: { id: `sp_${di}`, source: `d${di - 1}`, target: dayID, spine: true } })

    for (let si = 0; si < day.sessions.length; si++) {
      const session = day.sessions[si]!
      if (session.parentId) continue
      const sid = `s_${di}_${si}`
      const pos = wifiPos(si, day.sessions.length, dayX)
      const allPrompts: PromptEntry[] = [
        session.firstPrompt ?? { text: session.title, response: 'On it.', tools: [] },
        ...session.prompts,
      ]
      const pgp = promptGridPositions(pos.x, pos.y, dayX, allPrompts.length)

      const promptsData = allPrompts.map((p, pi) => ({
        text:     p.text,
        response: p.response,
        tools:    p.tools,
        time:     p.time,
        num:      pi + 1,
        gx:       pgp[pi]!.gx,
        gy:       pgp[pi]!.gy,
      }))

      els.push({
        data: {
          id: sid, type: "session",
          title:           session.title,
          firstPrompt:     session.firstPrompt?.text ?? session.title,
          time:            fmtDateTime(session.time),
          dayID,
          dayX:            pos.x,
          sesNum:          si + 1,
          sessionId:       session.id,
          parentSessionId: session.parentId,
          isAgent:         !!session.parentId,
          promptCount:     session.prompts.length,
          promptsData,
        },
        position: pos,
      })
      if (!session.parentId) els.push({ data: { id: `e_d_${sid}`, source: dayID, target: sid } })
      if (!session.parentId) {
        if (!sessionNodeMap.has(session.id)) sessionNodeMap.set(session.id, [])
        sessionNodeMap.get(session.id)!.push(sid)
      }
    }
  }

  for (const [, nodeIds] of sessionNodeMap.entries()) {
    for (let i = 1; i < nodeIds.length; i++) {
      els.push({ data: {
        id:           `cont_${nodeIds[i - 1]}_${nodeIds[i]}`,
        source:       nodeIds[i - 1]!,
        target:       nodeIds[i]!,
        continuation: true,
      }})
    }
  }

  return els
}

// ─── Build agent session map ───────────────────────────────────────────────────
function buildAgentSessionMap(days: DayGroup[]): Record<string, object[]> {
  const map: Record<string, object[]> = {}
  for (const day of days) {
    for (const session of day.sessions) {
      if (!session.parentId) continue
      const allPrompts: PromptEntry[] = [
        session.firstPrompt ?? { text: session.title, response: 'On it.', tools: [] },
        ...session.prompts,
      ]
      const entry = {
        sessionId:       session.id,
        parentSessionId: session.parentId,
        title:           session.title,
        promptCount:     session.prompts.length,
        promptsData:     allPrompts.map((p, pi) => ({
          text: p.text, response: p.response, tools: p.tools, time: p.time, num: pi + 1,
          gx: 0, gy: 0,
        })),
      }
      if (!map[session.parentId]) map[session.parentId] = []
      map[session.parentId]!.push(entry)
      map[session.id] = [entry]
    }
  }
  return map
}

// ─── Data injection ───────────────────────────────────────────────────────────
function injectDataIntoHTML(
  distHtml: string,
  title: string,
  directory: string,
  elements: object[],
  agentMap: Record<string, object[]>,
  catGifBase64: string | null,
  focusSessionId?: string,
): string {
  const safeJson = (v: unknown) => JSON.stringify(v).replace(/<\//g, "\\u003c/")
  const payload  = { elements, agentMap, title, directory, focusSessionId: focusSessionId ?? null, catGifBase64 }
  const dataScript = `<script>window.__GRAPH_DATA__ = ${safeJson(payload)};</script>\n`
  // Inject favicon synchronously so the browser picks it up before React mounts.
  const faviconScript = catGifBase64
    ? `<script>(function(){var l=document.createElement('link');l.rel='icon';l.type='image/gif';l.href=window.__GRAPH_DATA__.catGifBase64;document.head.appendChild(l);})();</script>\n`
    : ''
  return distHtml.replace("</head>", `${dataScript}${faviconScript}</head>`)
}

// ─── Public: project graph ─────────────────────────────────────────────────────
export function buildProjectGraphHTML(
  sessions: GraphSessionEntry[],
  projectDir: string,
  focusSessionId?: string,
): string {
  const days         = groupSessionsByDay(sessions)
  const focusSession = focusSessionId ? sessions.find(s => s.id === focusSessionId) : undefined
  const title        = focusSession?.title || projectDir.split("/").filter(Boolean).pop() || projectDir
  return injectDataIntoHTML(
    DIST_HTML, title, projectDir,
    buildElements(days), buildAgentSessionMap(days),
    catGifSrc() || null,
    focusSessionId,
  )
}

