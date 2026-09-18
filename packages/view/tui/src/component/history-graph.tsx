import { For, Show, createMemo, createSignal, createEffect, onCleanup, type Accessor } from "solid-js"
import { TextAttributes } from "@opentui/core"
import {
  C_OVERLAY_BG as C_BG,
  C_OVERLAY_BORDER as C_BORDER,
  C_OVERLAY_TEXT as C_TEXT,
  C_OVERLAY_DIM as C_DIM,
  C_OVERLAY_SELECT as C_SEL_BG,
  C_OVERLAY_ACCENT as C_ACCENT,
} from "../palette"
import { truncateLeft } from "../util/locale"

// ─── Exported types (consumed by app.tsx) ─────────────────────────────────────

export type GraphToolCall = {
  name: string
  input?: string
  output?: string
}

export type GraphPromptEntry = {
  text: string
  response: string
  tools: GraphToolCall[]
}

export type GraphSessionEntry = {
  id: string
  title: string
  directory: string
  timeCreated: number
  timeUpdated: number
  prompts: GraphPromptEntry[]
  parentId?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PATH_DISPLAY_WIDTH = 34
const MARQUEE_SPEED_MS = 100
const MARQUEE_DELAY_MS = 500
const MARQUEE_GAP = "     "

function truncateStr(str: string, max: number): string {
  const clean = str.replace(/\n+/g, " ").trim()
  return clean.length <= max ? clean : clean.slice(0, max) + "..."
}

function formatSessionTime(raw: number): string {
  if (!raw) return ""
  // Normalise microseconds → milliseconds
  const ms = raw > 1e13 ? Math.floor(raw / 1000) : raw
  if (ms <= 0) return ""
  const date = new Date(ms)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  if (isToday) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  }
  return (
    date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    "  " +
    date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  )
}

// ─── Session picker ───────────────────────────────────────────────────────────

function SessionPicker(props: {
  sessions: Accessor<GraphSessionEntry[]>
  loading: Accessor<boolean>
  selectedIndex: Accessor<number>
}) {
  const [marqueeOffset, setMarqueeOffset] = createSignal(0)
  let marqueeTimer: ReturnType<typeof setInterval> | null = null
  let marqueeDelay: ReturnType<typeof setTimeout> | null = null
  let listScrollEl: any

  function stopMarquee() {
    if (marqueeTimer) { clearInterval(marqueeTimer); marqueeTimer = null }
    if (marqueeDelay) { clearTimeout(marqueeDelay); marqueeDelay = null }
  }

  // Marquee: scroll the selected row's path after a brief pause
  createEffect(() => {
    const idx = props.selectedIndex()
    const session = props.sessions()[idx]

    stopMarquee()
    setMarqueeOffset(0)

    if (!session) return
    const path = session.directory
    if (path.length <= PATH_DISPLAY_WIDTH) return

    marqueeDelay = setTimeout(() => {
      marqueeDelay = null
      const loopLen = path.length + MARQUEE_GAP.length
      marqueeTimer = setInterval(() => {
        setMarqueeOffset((o) => (o + 1) % loopLen)
      }, MARQUEE_SPEED_MS)
    }, MARQUEE_DELAY_MS)
  })

  // Keep selected row visible in the scrollbox (each row is 1 line tall)
  createEffect(() => {
    const idx = props.selectedIndex()
    listScrollEl?.scrollTo?.(Math.max(0, idx - 3))
  })

  onCleanup(stopMarquee)

  function marqueePath(path: string, isSelected: boolean): string {
    if (!isSelected) return truncateLeft(path, PATH_DISPLAY_WIDTH)
    if (path.length <= PATH_DISPLAY_WIDTH) return path
    const looped = path + MARQUEE_GAP + path
    return looped.slice(marqueeOffset(), marqueeOffset() + PATH_DISPLAY_WIDTH)
  }


  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <Show
        when={!props.loading()}
        fallback={
          <box paddingLeft={1}>
            <text fg={C_DIM}>Loading sessions...</text>
          </box>
        }
      >
        <Show
          when={props.sessions().length > 0}
          fallback={
            <box paddingLeft={1}>
              <text fg={C_DIM}>No sessions found.</text>
            </box>
          }
        >
          <scrollbox
            ref={(el: any) => { listScrollEl = el }}
            flexGrow={1}
            verticalScrollbarOptions={{ visible: false }}
          >
            <For each={props.sessions()}>
              {(s, i) => {
                const isSel = () => i() === props.selectedIndex()
                return (
                  <box
                    flexDirection="row"
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={isSel() ? C_SEL_BG : undefined}
                  >
                    <box flexGrow={1}>
                      <text
                        fg={isSel() ? C_TEXT : C_DIM}
                        attributes={isSel() ? TextAttributes.BOLD : undefined}
                      >
                        {truncateStr(s.title || "Untitled", 30)}
                      </text>
                    </box>

                    <text fg={isSel() ? C_ACCENT : C_DIM} wrapMode="none">
                      {marqueePath(s.directory, isSel())}
                    </text>

                    <text fg={C_DIM}>{"  " + formatSessionTime(s.timeCreated)}</text>
                  </box>
                )
              }}
            </For>
          </scrollbox>
        </Show>
      </Show>
    </box>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function HistoryGraph(props: {
  visible: Accessor<boolean>
  loading: Accessor<boolean>
  sessions: Accessor<GraphSessionEntry[]>
  selectedIndex: Accessor<number>
}) {
  const total = () => props.sessions().length
  const positionLabel = () => (total() > 0 ? `${props.selectedIndex() + 1} / ${total()}` : "")

  return (
    <Show when={props.visible()}>
      <box flexDirection="column" flexGrow={1} backgroundColor={C_BG}>
        <box flexDirection="row" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={2}>
          <text fg={C_ACCENT} attributes={TextAttributes.BOLD}>Select Session</text>
          <box flexGrow={1} />
          <Show when={positionLabel()}>
            <text fg={C_DIM}>{positionLabel()}</text>
          </Show>
        </box>

        <box height={1} backgroundColor={C_BORDER} />

        <SessionPicker
          sessions={props.sessions}
          loading={props.loading}
          selectedIndex={props.selectedIndex}
        />

        <box flexDirection="row" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={2}>
          <box flexGrow={1} />
          <text fg={C_DIM}>up/down navigate  ·  enter open in browser  ·  esc close</text>
        </box>
      </box>
    </Show>
  )
}
