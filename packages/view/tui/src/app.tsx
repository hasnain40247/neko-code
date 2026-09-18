import { render, useRenderer } from "@opentui/solid"
import { registerNekoSpinner } from "./component/register-spinner"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { Deferred, Effect } from "effect"
import { Flag } from "./flag"
import { ExitProvider, useExit } from "./context/exit"
import { EpilogueProvider } from "./context/epilogue"
import { createCliRenderer, RGBA, SyntaxStyle, TextAttributes, type TextareaRenderable, type KeyEvent } from "@opentui/core"
import {
  Switch,
  Match,
  ErrorBoundary,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  For,
  Index,
  Show,
} from "solid-js"
import { createStore } from "solid-js/store"
import { ErrorComponent } from "./component/error-component"
import { SDKProvider, useSDK } from "./context/sdk"
import { registerNekoKeymap } from "./keymap"
import { SlashPalette, PALETTE_VIEWPORT, filterSlashCommands, isSkillName } from "./component/slash-palette"
import { SkillsPalette, type SkillPaletteItem } from "./component/skills-palette"
import { AgentPalette, type AgentPaletteItem, type AgentPalettePhase } from "./component/agent-palette"
import { MentionPalette, MENTION_VIEWPORT } from "./component/mention-palette"
import { McpPalette, type McpPaletteItem, type McpPalettePhase } from "./component/mcp-palette"
import { ThemePalette, type ThemePaletteItem, type ThemeName } from "./component/theme-palette"
import {
  ModelsPalette,
  type ModelsAuthPrompt,
  type ModelsPaletteGroup,
  type ModelsPaletteItem,
  type ModelsPaletteRow,
} from "./component/models-palette"
import { nekoCells, nekoLabel, nekoLanding, nekoLandingLabel, rgbHex } from "./logo"
import { AnimatedCat } from "./component/logo"
import {
  ACTIVE_THEME, GLOBAL_CONFIG_PATH, LIGHT_PALETTE, DARK_PALETTE, NEKO_LIGHT_PALETTE, NEKO_DARK_PALETTE, PALETTE,
  C_BG, C_EGG, C_WHITE, C_DIM, C_MUTED, C_INPUT, C_ACCENT, C_USER_BG, C_ACTIVE,
} from "./palette"
import * as fs from "node:fs"
import * as os from "node:os"
import * as pathMod from "node:path"
import { write as clipboardWrite } from "./clipboard"
import type { EventSource } from "./context/sdk"
import type { Args } from "./context/args"
import type { PermissionRequest } from "@gco/sdk/v2"
import type { TuiConfig } from "./config"
import { win32DisableProcessedInput, win32FlushInputBuffer } from "./terminal-win32"
import { destroyRenderer } from "./util/renderer"
import { cliErrorMessage, errorFormat } from "./util/error"
import { filetype } from "./util/filetype"
import { HistoryGraph, type GraphSessionEntry, type GraphPromptEntry, type GraphToolCall } from "./component/history-graph"

const DIFF_ADDED_SIGN = RGBA.fromHex("#22863A")
const DIFF_REMOVED_SIGN = RGBA.fromHex("#CB2431")
const DIFF_LINE_NUMBER_FG = RGBA.fromHex("#8A8A8A")
const DIFF_TRANSPARENT = RGBA.fromInts(0, 0, 0, 0)
const DIFF_SYNTAX = SyntaxStyle.fromTheme([])

// Hot rose used for the block-letter wordmark, matches the landing hero's
// centered wordmark color at t=0. Kept static so it stays visible after the
// landing → chat transition (centerLabelColor fades to bg once transitionT=1).
const NEKO_PINK_RGBA = RGBA.fromInts(0xE6, 0x3D, 0x8A)

// Playful placeholder pool shown in the landing input while the user hasn't
// sent their first message. One line is picked at random per app launch.
const LANDING_PLACEHOLDERS = [
  "what's the mission, meowster?",
  "paws-ready. what are we building?",
  "point me at some code, purrlease",
  "mreowwww! whats on the agenda",
  "purr-gramming time. where do we start?",
  "let's chase some bugs",
  "ready to pounce on some code",
  "drop a task, i'll get to work",
  "give me a task, i'm all ears",
  "curious what we're making today",
] as const

const pickLandingPlaceholder = () =>
  LANDING_PLACEHOLDERS[Math.floor(Math.random() * LANDING_PLACEHOLDERS.length)]!

registerNekoSpinner()

// Palette / theme state comes from ./palette (see readGlobalConfig).

// Syntax style for assistant markdown. Tree-sitter's markdown_inline grammar
// tags `**bold**` as `markup.strong`, `*italic*` as `markup.italic`, and
// `` `code` `` as `markup.raw` — without matching entries here those spans
// render as plain text.
const EMPTY_SYNTAX = SyntaxStyle.fromStyles({
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.strikethrough": { dim: true },
  "markup.raw": { fg: "#B4531A" },
  "markup.link.url": { fg: "#2E7D6E", underline: true },
  "markup.link.label": { fg: "#2E7D6E" },
})

// Styled syntax used only by the input textarea, so that @-mentions get
// highlighted (bold + accent color) inline as the user types or completes.
const INPUT_SYNTAX = SyntaxStyle.fromStyles({
  mention: { fg: "#2E7D6E", bold: true },   // deep sea-glass green — pops on cream
  skill:   { fg: "#B4531A", bold: true },   // burnt orange — visually distinct from @mentions
})
const MENTION_STYLE_ID = INPUT_SYNTAX.getStyleId("mention") ?? 0
const SKILL_STYLE_ID = INPUT_SYNTAX.getStyleId("skill") ?? 0
const MENTION_FG = RGBA.fromHex("#2E7D6E")

// Split `text` into alternating plain/mention segments so message rendering
// can bold-and-color `@path/to/file` tokens without losing surrounding text.
function splitMentions(text: string): Array<{ text: string; mention: boolean }> {
  const re = /(^|\s)(@\S+)/g
  const out: Array<{ text: string; mention: boolean }> = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const preLen = match[1]?.length ?? 0
    const start = match.index + preLen
    const end = start + (match[0].length - preLen)
    if (start > last) out.push({ text: text.slice(last, start), mention: false })
    out.push({ text: text.slice(start, end), mention: true })
    last = end
  }
  if (last < text.length) out.push({ text: text.slice(last), mention: false })
  return out.length > 0 ? out : [{ text, mention: false }]
}

// ─── Whimsical spinner words ───────────────────────────────────────────────────
const SPINNER_WORDS = [
  "Pondering",
  "Percolating",
  "Ruminating",
  "Contemplating",
  "Concocting",
  "Marinating",
  "Simmering",
  "Noodling",
  "Scheming",
  "Brewing",
  "Divining",
  "Puzzling",
  "Untangling",
  "Wrangling",
  "Chiseling",
  "Sculpting",
  "Distilling",
  "Whittling",
  "Manifesting",
  "Deliberating",
  "Synthesizing",
  "Rummaging",
  "Weaving",
  "Tinkering",
  "Cogitating",
  "Musing",
  "Coalescing",
  "Hatching",
  "Conjuring",
  "Herding",
]

const pickSpinnerWord = () => SPINNER_WORDS[Math.floor(Math.random() * SPINNER_WORDS.length)]!

// Circular / round glyphs for the tick-tock symbol beside the spinner word.
// Includes classic dot progression, half-filled circles, asterisks and floral
// stars — anything with rotational/circular form for a "weird but round" feel.
const SPINNER_SYMBOLS = [
  ".", "·", "∙", "•", "○", "●", "◉", "◎", "◍", "◌",
  "◐", "◑", "◒", "◓", "◔", "◕", "◖", "◗",
  "⊙", "⊚", "⊛", "⊜", "⊝",
  "⭘", "◯",
  "◆", "◇", "◈", "⚬",
  "✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺",
  "❂", "❃", "❉", "❊", "❋",
  "❄", "❅", "❆", "❇", "❈",
  "✻", "✼", "✽", "✾", "✿", "❀", "❁",
  "⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷",
  "◴", "◵", "◶", "◷",
  "◜", "◝", "◞", "◟", "◠", "◡",
  "⚪", "☉", "☼", "❍",
]
const pickSpinnerSymbol = (): string =>
  SPINNER_SYMBOLS[Math.floor(Math.random() * SPINNER_SYMBOLS.length)]!

// ─── Shine gradient helpers ────────────────────────────────────────────────────
type Rgb = { r: number; g: number; b: number }

const parseHex = (hex: string): Rgb => {
  const h = hex.replace("#", "")
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  }
}

const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")

const blendRgb = (a: Rgb, b: Rgb, t: number): Rgb => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
})

const rgbToHex = (c: Rgb) => `#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`

const blendHex = (a: Rgb, b: Rgb, t: number) => rgbToHex(blendRgb(a, b, t))

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)

const SHINE_BASE = parseHex("#B8A47C")   // muted warm — most of the word
const SHINE_PEAK = parseHex("#1A1A1A")   // near-black — the highlight
const SHINE_SIGMA = 1.5                  // width of the highlight in chars

const shineColorFor = (charIndex: number, position: number) => {
  const distance = charIndex - position
  const t = Math.exp(-(distance * distance) / (2 * SHINE_SIGMA * SHINE_SIGMA))
  return blendHex(SHINE_BASE, SHINE_PEAK, t)
}

// Status pill — renders as a rounded-left, flush-right chip inside the muted
// band. Colors are chosen so the pill reads as a distinct chip against tan
// PALETTE.muted, with a white shimmer sweeping the text during hold.
// Pill background: needs to (a) contrast against STATUS_BAND_BG (PALETTE.muted)
// so the slash-cap glyph shows a visible diagonal, and (b) be dark enough for
// the white shine peak to pop. Light mode uses PALETTE.dim (medium-dark brown
// against light-beige band). Dark mode uses a hand-picked deeper warm brown
// — darker than PALETTE.muted (#3A3835, our band bg) so the slash is visible,
// and much darker than the white shine peak.
const STATUS_PILL_BG_HEX   = ACTIVE_THEME === "dark" ? "#2A241C" : PALETTE.dim
const STATUS_PILL_BG_INFO  = parseHex(STATUS_PILL_BG_HEX)
const STATUS_PILL_BG_WARN  = parseHex(STATUS_PILL_BG_HEX)
const STATUS_PILL_BG_ERROR = parseHex(STATUS_PILL_BG_HEX)
// Pill text color — theme-aware so it contrasts with the (also theme-aware)
// pill bg above. Light: near-black on brown-ish bg. Dark: light beige on
// dark-tan bg — mirrors the "tab · next agent" hint tone. In both cases the
// shine peaks to pure white, giving a bright white sweep across the text.
const STATUS_PILL_FG       = parseHex(ACTIVE_THEME === "dark" ? PALETTE.egg : "#1A1A1A")
const STATUS_PILL_PEAK     = parseHex("#FFFFFF")
const STATUS_BAND_BG       = parseHex(PALETTE.muted)  // color behind the rounded cap glyph

// Total lifetime and phase boundaries. Cubic easing on enter/exit keeps the
// reveal feeling smooth rather than linear-stepped.
const STATUS_ENTER_MS = 650
const STATUS_HOLD_MS  = 4200
const STATUS_EXIT_MS  = 550
const STATUS_LIFETIME_MS = STATUS_ENTER_MS + STATUS_HOLD_MS + STATUS_EXIT_MS
const STATUS_TICK_MS = 16                          // ~60fps for the reveal / shine
const STATUS_SHINE_SIGMA = 2.6
const STATUS_SHINE_CHAR_MS = 60                    // per-char shine sweep speed (chars/sec ≈ 16)

// Powerline U+E0BA (Nerd Font) — lower-right-triangle glyph used as a slash-
// styled left cap. Rendered with fg=pill color, bg=band color so the pill
// fills the lower-right of the cell with a "/" diagonal edge and the band
// shows through the upper-left corner.
const STATUS_CAP_LEFT = ""

// Pill-colored spaces on each side of the text so the message doesn't butt
// against the slash cap on the left or the terminal edge on the right, while
// the pill background still runs continuously through both padding regions.
const STATUS_PILL_PAD_LEFT  = 1
const STATUS_PILL_PAD_RIGHT = 1

type StatusKind = "info" | "warn" | "error"

const statusPillBgRgb = (kind: StatusKind): Rgb =>
  kind === "error" ? STATUS_PILL_BG_ERROR : kind === "warn" ? STATUS_PILL_BG_WARN : STATUS_PILL_BG_INFO

// Cubic ease-out for the enter reveal, ease-in for the exit wipe. Returns a
// FRACTIONAL number of visible characters — the integer part is how many
// full-opacity cells are showing, the fractional part is the alpha of the
// leading (leftmost) cell. Fractional reveal is what keeps the slide smooth:
// integer stepping made the pill hop one whole cell per frame, which reads as
// choppy no matter how high the framerate.
const statusRevealCount = (elapsedMs: number, textLength: number): number => {
  if (elapsedMs <= 0) return 0
  if (elapsedMs < STATUS_ENTER_MS) {
    const t = elapsedMs / STATUS_ENTER_MS
    const eased = 1 - Math.pow(1 - t, 3)
    return Math.min(textLength, eased * textLength)
  }
  if (elapsedMs < STATUS_ENTER_MS + STATUS_HOLD_MS) return textLength
  const t = clamp01((elapsedMs - STATUS_ENTER_MS - STATUS_HOLD_MS) / STATUS_EXIT_MS)
  const eased = Math.pow(t, 3)
  return Math.max(0, (1 - eased) * textLength)
}

// Per-char fg color inside the pill (before leading-edge alpha blend). Returns
// Rgb so callers can further blend with the band background for smooth reveal.
const statusShineColorRgb = (localIndex: number, textLength: number, elapsedMs: number): Rgb => {
  const holdT = elapsedMs - STATUS_ENTER_MS
  if (holdT < 0 || holdT > STATUS_HOLD_MS) return STATUS_PILL_FG
  const sweepWidth = textLength + 8
  const sweepPeriodMs = sweepWidth * STATUS_SHINE_CHAR_MS
  const cyc = (holdT % sweepPeriodMs) / sweepPeriodMs
  const shinePos = -4 + cyc * sweepWidth
  const dist = localIndex - shinePos
  const g = Math.exp(-(dist * dist) / (2 * STATUS_SHINE_SIGMA * STATUS_SHINE_SIGMA))
  return blendRgb(STATUS_PILL_FG, STATUS_PILL_PEAK, g)
}


export type TuiInput = {
  url: string
  args: Args
  config: TuiConfig.Resolved
  onSnapshot?: () => Promise<string[]>
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
}

export const run = Effect.fn("Tui.run")(function* (input: TuiInput) {
  const exit = { epilogue: undefined as string | undefined, reason: undefined as unknown }
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const renderer = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            createCliRenderer({
              externalOutputMode: "passthrough",
              targetFps: 60,
              gatherStats: false,
              exitOnCtrlC: false,
              useKittyKeyboard: {},
              autoFocus: false,
              openConsoleOnError: false,
              useMouse: !Flag.NEKO_DISABLE_MOUSE && input.config.mouse,
              consoleOptions: {
                keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
              },
            }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
        (renderer) =>
          Effect.sync(() => {
            destroyRenderer(renderer)
          }),
      )
      win32DisableProcessedInput()
      const keymap = createDefaultOpenTuiKeymap(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => registerNekoKeymap(keymap, renderer, input.config)),
        (unregister) => Effect.sync(unregister),
      )
      const shutdown = yield* Deferred.make<unknown>()
      const onSighup = () => destroyRenderer(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => process.on("SIGHUP", onSighup)),
        () => Effect.sync(() => process.off("SIGHUP", onSighup)),
      )
      renderer.once("destroy", () => Deferred.doneUnsafe(shutdown, Effect.void))

      yield* Effect.tryPromise(async () => {
        void renderer.getPalette({ size: 16 }).catch(() => undefined)
        const mode = (await renderer.waitForThemeMode(1000)) ?? "dark"
        if (renderer.isDestroyed) return

        await render(() => {
          return (
            <ExitProvider
              exit={(reason) => {
                if (renderer.isDestroyed) return
                exit.reason = reason
                destroyRenderer(renderer)
              }}
            >
              <EpilogueProvider set={(value) => (exit.epilogue = value)}>
                <ErrorBoundary fallback={(error, reset) => <ErrorComponent error={error} reset={reset} mode={mode} />}>
                  <SDKProvider
                    url={input.url}
                    directory={input.directory}
                    fetch={input.fetch}
                    headers={input.headers}
                    events={input.events}
                  >
                    <Chat args={input.args} />
                  </SDKProvider>
                </ErrorBoundary>
              </EpilogueProvider>
            </ExitProvider>
          )
        }, renderer)
      })
      yield* Deferred.await(shutdown)
      return { epilogue: exit.epilogue, reason: exit.reason }
    }),
  )
  yield* Effect.sync(() => {
    win32FlushInputBuffer()
    if (result.reason !== undefined)
      process.stderr.write((cliErrorMessage(result.reason) ?? errorFormat(result.reason)) + "\n")
    if (result.epilogue) process.stdout.write(result.epilogue + "\n")
  })
})

// ─── Types ─────────────────────────────────────────────────────────────────────

type ChatPart = {
  id: string
  messageID: string
  type: "text" | "tool" | "reasoning"
  text?: string
  tool?: string
  callID?: string
  state?: {
    status: "running" | "completed" | "error"
    input?: any
    output?: string
    error?: string
    metadata?: any
  }
}

type ChatMessage = {
  id: string
  role: "user" | "assistant"
  agent?: string
}

type SubagentState = "running" | "completed" | "error"

type SubagentTranscript = {
  childSid: string
  subagentType: string
  description?: string
  state: SubagentState
  msgOrder: string[]
  msgs: Record<string, ChatMessage>
  partOrder: Record<string, string[]>
  parts: Record<string, ChatPart>
}

// ─── NestedSubagentTranscript ──────────────────────────────────────────────────
// Shows the child session's activity nested under the spawning task/agent tool
// row. Only assistant parts are rendered — the initial user prompt is the tool
// input, so showing it again would be redundant. Collapsible via chevron.
function NestedSubagentTranscript(props: {
  transcript: SubagentTranscript
  agentColor: (name: string) => RGBA
}) {
  // Collapsed by default — expand on click to watch or inspect activity.
  const [collapsed, setCollapsed] = createSignal(true)

  const chevron = () => (collapsed() ? "▶" : "▼")
  const stateGlyph = () =>
    props.transcript.state === "running"
      ? "…"
      : props.transcript.state === "error"
        ? "✗"
        : "✓"

  const msgs = () =>
    props.transcript.msgOrder
      .map((id) => props.transcript.msgs[id])
      .filter((m) => m && m.role === "assistant")

  return (
    <box gap={0} marginTop={1} paddingLeft={2}>
      <box onMouseUp={() => setCollapsed((c) => !c)}>
        <text
          fg={props.agentColor(props.transcript.subagentType)}
          attributes={TextAttributes.BOLD}
        >
          {chevron()} ▎ {props.transcript.subagentType} {stateGlyph()}
        </text>
      </box>
      <Show when={!collapsed()}>
        <box paddingLeft={2}>
          <For each={msgs()}>
            {(msg) => {
              const parts = () =>
                (props.transcript.partOrder[msg!.id] ?? [])
                  .map((k) => props.transcript.parts[k])
                  .filter(Boolean) as ChatPart[]
              return (
                <For each={parts()}>
                  {(part) => (
                    <Switch>
                      <Match when={part.type === "text" && part.text?.trim()}>
                        <text fg={C_EGG} wrapMode="word">
                          <For each={splitMentions(part.text!.trim())}>
                            {(seg) =>
                              seg.mention ? (
                                <span style={{ fg: MENTION_FG, attributes: TextAttributes.BOLD }}>{seg.text}</span>
                              ) : (
                                <span>{seg.text}</span>
                              )
                            }
                          </For>
                        </text>
                      </Match>
                      <Match when={part.type === "tool"}>
                        {/* Nested tool rows render without their own subagent
                            lookup — one level of nesting is enough. */}
                        <ToolRow part={part} />
                      </Match>
                    </Switch>
                  )}
                </For>
              )
            }}
          </For>
        </box>
      </Show>
    </box>
  )
}

// ─── ToolRow ───────────────────────────────────────────────────────────────────

function ToolRow(props: {
  part: ChatPart
  lookupSubagent?: (callID: string) => SubagentTranscript | undefined
  agentColor?: (name: string) => RGBA
}) {
  const [collapsed, setCollapsed] = createSignal(true)
  const status = () => props.part.state?.status ?? "running"
  const name = () => props.part.tool ?? "tool"
  const inputStr = () => {
    const inp = props.part.state?.input
    if (!inp) return ""
    // For agent/task delegation tools, the raw JSON is noise — surface the
    // human-readable description and subagent_type instead.
    if ((name() === "agent" || name() === "task") && typeof inp === "object") {
      const rec = inp as { description?: string; subagent_type?: string }
      const sub = rec.subagent_type ? `(${rec.subagent_type}) ` : ""
      const desc = rec.description ?? ""
      const label = `${sub}${desc}`.trim()
      return label || "spawning subagent"
    }
    // For the question tool, show the actual question text(s) instead of raw JSON.
    if (name() === "question" && typeof inp === "object") {
      const qs = (inp as { questions?: Array<{ question?: string }> }).questions
      if (Array.isArray(qs) && qs.length) {
        return qs.map(q => q.question ?? "").filter(Boolean).join(" / ")
      }
    }
    // For bash/shell commands, show just the command string.
    if ((name() === "bash" || name() === "shell") && typeof inp === "object") {
      const cmd = (inp as { command?: string }).command
      if (typeof cmd === "string") return cmd
    }
    return typeof inp === "string" ? inp : JSON.stringify(inp)
  }
  const output = () => {
    const o = props.part.state?.output?.trim() ?? ""
    return o.length > 3000 ? o.slice(0, 3000) + "\n…" : o
  }
  // For edit / apply_patch tools, the tool result carries the unified patch on
  // metadata.diff or metadata.files[0].patch — render it as a colored diff with
  // line numbers instead of dumping the raw ```diff-fenced output text.
  const diffPatch = () => {
    if (name() !== "edit" && name() !== "apply_patch") return undefined
    const md = props.part.state?.metadata
    if (!md || typeof md !== "object") return undefined
    const direct = (md as { diff?: unknown }).diff
    if (typeof direct === "string" && direct.length) return direct
    const files = (md as { files?: unknown }).files
    if (Array.isArray(files)) {
      const first = files[0] as { patch?: unknown } | undefined
      if (first && typeof first.patch === "string" && first.patch.length) return first.patch
    }
    return undefined
  }
  const diffFilePath = () => {
    const inp = props.part.state?.input as { filePath?: unknown; path?: unknown } | undefined
    const fp = inp?.filePath ?? inp?.path
    return typeof fp === "string" ? fp : undefined
  }
  const icon = () => (status() === "running" ? "~" : status() === "error" ? "✗" : "✓")
  const color = () => (status() === "error" ? RGBA.fromHex("#CC6666") : C_DIM)
  const hasDiff = () => diffPatch() !== undefined && status() === "completed"
  const hasOutput = () => (hasDiff() || Boolean(output())) && status() !== "running"
  const chevron = () => (hasOutput() ? (collapsed() ? "▶" : "▼") : " ")

  const subagent = () =>
    props.lookupSubagent && props.part.callID
      ? props.lookupSubagent(props.part.callID)
      : undefined

  return (
    <box gap={0} marginTop={1}>
      <box
        onMouseUp={() => {
          if (hasOutput()) setCollapsed((prev) => !prev)
        }}
      >
        <text fg={color()} wrapMode="word">
          {chevron()} {icon()} {name()} {inputStr()}
        </text>
      </box>
      <Show when={subagent() && props.agentColor}>
        <NestedSubagentTranscript
          transcript={subagent()!}
          agentColor={props.agentColor!}
        />
      </Show>
      <Show when={hasOutput() && !collapsed()}>
        <Switch
          fallback={
            <text fg={C_DIM} wrapMode="word" paddingLeft={2}>
              {output()}
            </text>
          }
        >
          <Match when={hasDiff()}>
            <box paddingLeft={2} paddingTop={0}>
              <diff
                diff={diffPatch()!}
                view="unified"
                filetype={filetype(diffFilePath())}
                syntaxStyle={DIFF_SYNTAX}
                showLineNumbers={true}
                width="100%"
                fg={C_EGG}
                addedBg={DIFF_TRANSPARENT}
                removedBg={DIFF_TRANSPARENT}
                contextBg={DIFF_TRANSPARENT}
                addedSignColor={DIFF_ADDED_SIGN}
                removedSignColor={DIFF_REMOVED_SIGN}
                lineNumberFg={DIFF_LINE_NUMBER_FG}
                lineNumberBg={DIFF_TRANSPARENT}
                addedLineNumberBg={DIFF_TRANSPARENT}
                removedLineNumberBg={DIFF_TRANSPARENT}
              />
            </box>
          </Match>
        </Switch>
      </Show>
    </box>
  )
}

// ─── AssistantRow ──────────────────────────────────────────────────────────────

function AssistantRow(props: {
  parts: () => ChatPart[]
  agent?: string
  agentColor: (name: string) => RGBA
  lookupSubagent?: (callID: string) => SubagentTranscript | undefined
}) {
  return (
    <box paddingTop={1} paddingLeft={4} paddingRight={4} flexShrink={0} gap={0}>
      <Show when={props.agent}>
        {(name) => (
          <text fg={props.agentColor(name())} attributes={TextAttributes.BOLD} marginBottom={1}>
            {"▎ "}
            {name()}
          </text>
        )}
      </Show>
      <For each={props.parts()}>
        {(part) => (
          <Switch>
            <Match when={part.type === "text" && part.text?.trim()}>
              <markdown
                content={part.text!.trim()}
                streaming={true}
                syntaxStyle={EMPTY_SYNTAX}
                fg={C_EGG}
                bg={C_BG}
              />
            </Match>
            <Match when={part.type === "reasoning" && part.text?.trim()}>
              <text fg={C_DIM} wrapMode="word">
                [thinking] {part.text!.trim()}
              </text>
            </Match>
            <Match when={part.type === "tool"}>
              <ToolRow
                part={part}
                lookupSubagent={props.lookupSubagent}
                agentColor={props.agentColor}
              />
            </Match>
          </Switch>
        )}
      </For>
    </box>
  )
}

// ─── UserRow ───────────────────────────────────────────────────────────────────

function UserRow(props: { parts: () => ChatPart[] }) {
  const text = () =>
    props
      .parts()
      .filter((p) => p.type === "text" && p.text?.trim())
      .map((p) => p.text!)
      .join("\n")
  return (
    <Show when={text()}>
      <box paddingTop={1} paddingLeft={4} paddingRight={4} flexShrink={0}>
        <box
          backgroundColor={C_USER_BG}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
        >
          <text fg={C_WHITE} wrapMode="word">
            <For each={splitMentions(text())}>
              {(seg) =>
                seg.mention ? (
                  <b style={{ fg: MENTION_FG }}>{seg.text}</b>
                ) : (
                  <span>{seg.text}</span>
                )
              }
            </For>
          </text>
        </box>
      </box>
    </Show>
  )
}

// ─── MessageRow ────────────────────────────────────────────────────────────────

type StoreShape = {
  msgOrder: string[]
  msgs: Record<string, ChatMessage>
  partOrder: Record<string, string[]>
  parts: Record<string, ChatPart>
  // Subagent transcripts nested under the spawning tool call.
  subagents: Record<string /* toolCallID */, SubagentTranscript>
  subagentByChildSid: Record<string /* childSid */, string /* toolCallID */>
}

const partKey = (messageID: string, partID: string) => `${messageID}::${partID}`

function MessageRow(props: {
  msgID: string
  store: StoreShape
  agentColor: (name: string) => RGBA
  lookupSubagent: (callID: string) => SubagentTranscript | undefined
}) {
  const msg = () => props.store.msgs[props.msgID]
  const parts = () =>
    (props.store.partOrder[props.msgID] ?? []).map((key) => props.store.parts[key]).filter(Boolean)

  // Multi-step turns produce multiple assistant messages back-to-back — one
  // per LLM step. Only render the agent badge on the FIRST assistant message
  // of a run (i.e. when the previous message was a user, or a different agent).
  const shouldShowBadge = () => {
    const m = msg()
    if (!m || m.role !== "assistant") return false
    const idx = props.store.msgOrder.indexOf(props.msgID)
    if (idx <= 0) return true
    const prev = props.store.msgs[props.store.msgOrder[idx - 1]]
    if (!prev) return true
    if (prev.role !== "assistant") return true
    return prev.agent !== m.agent
  }

  return (
    <Show when={msg()}>
      {(m) => (
        <Show
          when={m().role === "user"}
          fallback={
            <AssistantRow
              parts={parts}
              agent={shouldShowBadge() ? m().agent : undefined}
              agentColor={props.agentColor}
              lookupSubagent={props.lookupSubagent}
            />
          }
        >
          <UserRow parts={parts} />
        </Show>
      )}
    </Show>
  )
}

// ─── Chat ──────────────────────────────────────────────────────────────────────

function Chat(props: { args: Args }) {
  const sdk = useSDK()
  const exit = useExit()
  const renderer = useRenderer()

  // Terminal size — width collapses the footer, height compacts the landing hero.
  const [termWidth, setTermWidth] = createSignal(renderer.terminalWidth)
  const [termHeight, setTermHeight] = createSignal(renderer.terminalHeight)
  const onTermResize = (w: number, h: number) => { setTermWidth(w); setTermHeight(h) }
  renderer.on("resize", onTermResize)
  onCleanup(() => renderer.off("resize", onTermResize))
  const footerNarrow = () => termWidth() < 90
  // Landing hero: nekoLanding is 18 rows tall + label 3 + padding — needs ~30
  // rows to sit above the input comfortably. Below that, arrange cat and label
  // side-by-side instead so both stay visible.
  const landingCompact = () => termHeight() < 34

  // In "auto" we auto-reply "once" to every permission.asked event; in "normal"
  // we surface an inline prompt so the user can allow/always/reject each call.
  const [permissionMode, setPermissionMode] = createSignal<"auto" | "normal">(
    props.args.auto ? "auto" : "normal",
  )
  const [pendingPermission, setPendingPermission] = createSignal<PermissionRequest | null>(null)
  function replyPermission(reply: "once" | "always" | "reject") {
    const req = pendingPermission()
    if (!req) return
    setPendingPermission(null)
    void sdk.client.permission.reply({ requestID: req.id, reply }).catch(() => {})
  }

  // Question prompt state
  type PendingQuestion = {
    id: string
    sessionID: string
    questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiple?: boolean; custom?: boolean }>
    tool?: { messageID: string; callID: string }
  }
  const [pendingQuestion, setPendingQuestion] = createSignal<PendingQuestion | null>(null)
  const [questionSelected, setQuestionSelected] = createSignal(0)
  const [questionAnswers, setQuestionAnswers] = createSignal<string[][]>([[]])
  const [questionTab, setQuestionTab] = createSignal(0)
  // Custom text input mode: when user selects the "Type your own" slot
  const [questionCustomMode, setQuestionCustomMode] = createSignal(false)
  const [questionCustomText, setQuestionCustomText] = createSignal("")

  function replyQuestion(answers: string[][]) {
    const req = pendingQuestion()
    if (!req) return
    setPendingQuestion(null)
    setQuestionCustomMode(false)
    setQuestionCustomText("")
    void sdk.client.question.reply({ requestID: req.id, answers, directory: sdk.directory }).catch(() => {})
  }
  function rejectQuestion() {
    const req = pendingQuestion()
    if (!req) return
    setPendingQuestion(null)
    setQuestionCustomMode(false)
    setQuestionCustomText("")
    void sdk.client.question.reject({ requestID: req.id, directory: sdk.directory }).catch(() => {})
  }
  const togglePermissionMode = () => {
    setPermissionMode((m) => (m === "auto" ? "normal" : "auto"))
    showStatus(`Permission mode: ${permissionMode()}`)
    // Flipping to auto while a request is pending should approve it too.
    if (permissionMode() === "auto" && pendingPermission()) replyPermission("once")
  }

  const cwdLabel = (() => {
    const dir = sdk.directory ?? process.cwd()
    const home = os.homedir()
    return dir === home
      ? "~"
      : dir.startsWith(home + pathMod.sep)
        ? "~" + dir.slice(home.length)
        : dir
  })()

  const [sessionID, setSessionID] = createSignal<string | null>(null)
  const [running, setRunning] = createSignal(false)
  const [spinnerWord, setSpinnerWord] = createSignal(pickSpinnerWord())
  const [shinePos, setShinePos] = createSignal(0)

  // Cost / time / context tracking.
  // `lastAssistant` mirrors the freshest assistant AssistantMessage so we can
  // compute live token totals, context %, and cumulative cost — the base store
  // only keeps { id, role, agent } for rendering.
  const [lastAssistant, setLastAssistant] = createSignal<{
    id: string
    timeCreated: number
    providerID: string
    modelID: string
    cost: number
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: { read: number; write: number }
    }
  }>()
  const [modelLimits, setModelLimits] = createSignal<Record<string, number>>({})
  const [turnStart, setTurnStart] = createSignal<number | undefined>(undefined)
  const [nowTs, setNowTs] = createSignal(Date.now())
  const [store, setStore] = createStore<StoreShape>({
    msgOrder: [],
    msgs: {},
    partOrder: {},
    parts: {},
    subagents: {},
    subagentByChildSid: {},
  })

  // ── Agents ──────────────────────────────────────────────────────────────
  // Fetched from /agent. Only "primary" (non-hidden, non-subagent) agents
  // participate in Tab cycling — hidden agents (compaction/title/summary)
  // fire internally, and subagents are invoked via TaskTool.
  type AgentEntry = { name: string; description?: string; mode?: string; hidden?: boolean; color?: string }
  const [agents, setAgents] = createSignal<AgentEntry[]>([])
  const [agentIndex, setAgentIndex] = createSignal(0)
  const currentAgent = () => agents()[agentIndex()]
  const currentAgentName = () => currentAgent()?.name ?? "build"

  // Distinct, warm-paper-friendly colors that pop against C_BG (#F5F1E8).
  // Known agents get curated colors; anything else falls back through the
  // palette by index. Kept saturated enough to read as a "chip" but not
  // neon — this UI is intentionally soft.
  const AGENT_COLORS: Record<string, string> = {
    build:   "#2E7D6E",   // deep sea-glass green — confident, "doing work"
    plan:    "#C05F3F",   // persimmon — advisory, cautious
    explore: "#3D6FB8",   // cobalt blue — cool, searching, spelunking
    general: "#7D5A9B",   // plum-violet — versatile, generalist
  }
  const AGENT_PALETTE = ["#2E7D6E", "#C05F3F", "#3D6FB8", "#7D5A9B", "#B5843A"]
  const agentColor = (name: string) => {
    if (AGENT_COLORS[name]) return RGBA.fromHex(AGENT_COLORS[name])
    const idx = agents().findIndex((a) => a.name === name)
    const hex = AGENT_PALETTE[(idx >= 0 ? idx : 0) % AGENT_PALETTE.length]
    return RGBA.fromHex(hex)
  }

  onMount(async () => {
    const res = await sdk.client.app.agents({}).catch(() => null)
    const list = (res?.data ?? []) as AgentEntry[]
    if (!Array.isArray(list) || list.length === 0) return
    const primary = list.filter((a) => !a.hidden && a.mode !== "subagent")
    if (primary.length === 0) return
    setAgents(primary)
    const buildIdx = primary.findIndex((a) => a.name === "build")
    setAgentIndex(buildIdx >= 0 ? buildIdx : 0)
  })

  // Model context-limit lookup, keyed as "providerID/modelID".
  onMount(async () => {
    try {
      const res = await sdk.client.provider.list({} as any).catch(() => null)
      const data = res?.data as
        | {
            providers?: Array<{
              id: string
              models: Record<string, { limit?: { context?: number } }>
            }>
            connected?: string[]
          }
        | undefined
      const providers = data?.providers ?? []
      const map: Record<string, number> = {}
      for (const p of providers) {
        for (const [mid, m] of Object.entries(p.models ?? {})) {
          const c = m?.limit?.context
          if (typeof c === "number" && c > 0) map[`${p.id}/${mid}`] = c
        }
      }
      setModelLimits(map)
      // Prime the connected-provider set so the submit gate can tell whether
      // the current model's provider has a key configured before the user's
      // first prompt (without waiting for them to open /models).
      const connectedList: string[] = Array.isArray(data?.connected)
        ? data!.connected.filter((s): s is string => typeof s === "string")
        : []
      setModelsConnected(new Set<string>(connectedList))
      // Populate Ollama models if Ollama is running.
      const ollamaData = providers.find((p) => p.id === "ollama")
      if (ollamaData && connectedList.includes("ollama")) {
        const items: ModelsPaletteItem[] = Object.keys(ollamaData.models ?? {}).map((id) => ({
          providerID: "ollama",
          modelID: id,
          label: id,
        }))
        setOllamaModelItems(items)
      }
    } catch {
      // Provider list is best-effort; context % just won't show a percentage.
    }
    // Prime the "current model" indicator from neko.json so the footer + palette
    // can label it before the user opens /models or triggers the first turn.
    // Only honor the config's model if its provider actually has a key —
    // otherwise the server's hardcoded `deepseek/deepseek-v4-flash` default
    // would make the landing footer claim deepseek is selected on a fresh
    // install with no neko.json.
    try {
      const cfgRes = await sdk.client.config.get({}).catch(() => null)
      const cfg = cfgRes?.data as { model?: string } | undefined
      if (cfg && typeof cfg.model === "string") {
        const provider = cfg.model.includes("/") ? cfg.model.split("/")[0] : cfg.model
        if (provider && modelsConnected().has(provider)) setModelsCurrentKey(cfg.model)
      }
    } catch { /* footer just won't show a model name until first turn */ }
  })

  // Turn timer: stamp on every idle→busy transition, but leave `turnStart`
  // pinned once the turn ends so the "3s · 245 tok" line stays visible next to
  // where the spinner was until the next turn overwrites it.
  createEffect(() => {
    if (running()) {
      setTurnStart(Date.now())
      setNowTs(Date.now())
    }
  })

  // Only tick while the model is running — when it finishes, `nowTs` freezes,
  // which freezes `elapsedSecs` at the final duration.
  createEffect(() => {
    if (!running()) return
    const timer = setInterval(() => setNowTs(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    if (!running()) return
    setSpinnerWord(pickSpinnerWord())
    const wordTimer = setInterval(() => setSpinnerWord(pickSpinnerWord()), 2500)
    onCleanup(() => clearInterval(wordTimer))
  })

  // ── Landing hero → chat transition ───────────────────────────────────────
  // When there are no messages yet, we show a centered landing screen with
  // the animated neko ASCII + a "neko" wordmark under the input. On the
  // user's first submit we run a ~500ms transition: the ASCII fades to
  // background, the centered wordmark fades out while a corner wordmark
  // fades in, and a flexGrow spacer under the input collapses so the input
  // settles at the bottom of the terminal.
  const [hasStartedChat, setHasStartedChat] = createSignal(false)
  // Picked once per Chat mount so the placeholder stays stable while the user
  // is on the landing hero, and re-rolls on next app launch.
  const landingPlaceholder = pickLandingPlaceholder()

  // Landing-hero animation: cycle through nekoLanding.frames while the user
  // hasn't started chatting yet. Cheap wall-clock timer; unmounted with the
  // component via onCleanup.
  const [landingFrame, setLandingFrame] = createSignal(0)
  const landingTimer = setInterval(() => {
    if (hasStartedChat()) return
    setLandingFrame((f) => (f + 1) % nekoLanding.frames.length)
  }, nekoLanding.delayMs)
  onCleanup(() => clearInterval(landingTimer))
  const landingCells = () => nekoLanding.frames[landingFrame()]!
  const [transitionT, setTransitionT] = createSignal(0)  // 0 = fresh, 1 = chat
  createEffect(() => {
    if (!hasStartedChat()) return
    const start = performance.now()
    const duration = 500
    const raf = setInterval(() => {
      const t = Math.min(1, (performance.now() - start) / duration)
      setTransitionT(t)
      if (t >= 1) clearInterval(raf)
    }, 32)
    onCleanup(() => clearInterval(raf))
  })

  // Popping pink used for both the centered and corner "neko" wordmarks.
  const NEKO_PINK = { r: 0xE6, g: 0x3D, b: 0x8A }   // hot rose — pops on either palette

  // Fade interpolation targets against the active theme's bg color so the
  // "fade to invisible" effect actually blends with the surface.
  const bgRgb = () => parseHex(PALETTE.bg)

  const centerLabelColor = () => {
    const t = transitionT()
    return RGBA.fromHex(blendHex(NEKO_PINK, bgRgb(), t))
  }
  // Weird circular symbol next to the spinner word — cycles fast through a
  // grab-bag of dots, half-circles, asterisks and braille dots.
  const [spinnerSymbol, setSpinnerSymbol] = createSignal(pickSpinnerSymbol())
  createEffect(() => {
    if (!running()) return
    setSpinnerSymbol(pickSpinnerSymbol())
    const symbolTimer = setInterval(() => setSpinnerSymbol(pickSpinnerSymbol()), 90)
    onCleanup(() => clearInterval(symbolTimer))
  })

  const elapsedSecs = () => {
    const start = turnStart()
    if (start === undefined) return 0
    return Math.max(0, Math.floor((nowTs() - start) / 1000))
  }

  // Output tokens for the current turn only — filter by whether the last
  // AssistantMessage was created after this turn started (small backdate for
  // clock skew between server and client).
  const liveOutputTokens = () => {
    const start = turnStart()
    const last = lastAssistant()
    if (start === undefined || !last) return 0
    if (last.timeCreated < start - 1000) return 0
    return last.tokens.output
  }

  const streamingStats = () => {
    const parts: string[] = []
    const secs = elapsedSecs()
    if (secs > 0) parts.push(`${secs}s`)
    const t = liveOutputTokens()
    if (t > 0) parts.push(`${t.toLocaleString()} tok`)
    return parts.join(" · ")
  }

  const contextUsage = () => {
    const last = lastAssistant()
    if (!last) return undefined
    const tot =
      last.tokens.input +
      last.tokens.output +
      last.tokens.reasoning +
      last.tokens.cache.read +
      last.tokens.cache.write
    if (tot <= 0) return undefined
    const limit = modelLimits()[`${last.providerID}/${last.modelID}`]
    if (!limit) return undefined
    const pct = Math.round((tot / limit) * 100)
    if (pct < 80) return undefined
    return `${pct}% (${tot.toLocaleString()})`
  }

  // "Current model" for the footer. Reflects user intent (config default on
  // mount, or the last /models selection) — not what the runner may have
  // baked into an older session. Falls back to lastAssistant only if intent
  // is unknown (should be rare since we prime on mount).
  const activeModelName = () => {
    const key = modelsCurrentKey()
    if (key) return key.includes("/") ? key.split("/")[1] : key
    const last = lastAssistant()
    if (last?.modelID) return last.modelID
    return undefined
  }

  createEffect(() => {
    if (!running()) return
    setShinePos(-3)
    const shineTimer = setInterval(() => {
      setShinePos((prev) => {
        const len = spinnerWord().length + 4
        const next = prev + 0.5
        return next > len ? -3 : next
      })
    }, 60)
    onCleanup(() => clearInterval(shineTimer))
  })

  let inputEl: TextareaRenderable | undefined
  let scrollEl: any

  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [paletteQuery, setPaletteQuery] = createSignal("")
  const [paletteIndex, setPaletteIndex] = createSignal(0)
  const [paletteScrollTop, setPaletteScrollTop] = createSignal(0)
  const [skills, setSkills] = createSignal<Array<{ name: string; description: string }>>([])
  const paletteMatches = () => filterSlashCommands(paletteQuery(), skills())

  // Dedicated skills palette modal (opened by /skills).
  const [skillsPaletteOpen, setSkillsPaletteOpen] = createSignal(false)
  const [skillsPaletteIndex, setSkillsPaletteIndex] = createSignal(0)

  // History graph panel (opened by /graph).
  const [historyGraphOpen, setHistoryGraphOpen] = createSignal(false)
  const [historyGraphIndex, setHistoryGraphIndex] = createSignal(0)
  const [historyGraphLoading, setHistoryGraphLoading] = createSignal(false)
  const [historyGraphSessions, setHistoryGraphSessions] = createSignal<GraphSessionEntry[]>([])
  const skillsPaletteItems = (): SkillPaletteItem[] =>
    skills().map((s) => ({ name: s.name, description: s.description }))

  // Skills are discovered at TUI mount by scanning ./skills and ~/.config/neko/skills.
  // Fire once — reload requires a TUI restart, which is acceptable for MVP.
  void (async () => {
    try {
      const res = await sdk.client.app.skills({}).catch(() => null)
      const list = (res?.data ?? []) as Array<{ name: string; description?: string }>
      setSkills(list.map((s) => ({ name: s.name, description: s.description ?? "" })))
    } catch {}
  })()

  // ── @ file mention palette ──────────────────────────────────────────────
  const [mentionOpen, setMentionOpen] = createSignal(false)
  const [mentionQuery, setMentionQuery] = createSignal("")
  const [mentionResults, setMentionResults] = createSignal<string[]>([])
  const [mentionIndex, setMentionIndex] = createSignal(0)
  const [mentionScrollTop, setMentionScrollTop] = createSignal(0)
  const [mentionLoading, setMentionLoading] = createSignal(false)
  let mentionFetchSeq = 0
  let mentionFetchTimer: ReturnType<typeof setTimeout> | undefined
  // One-shot: set when completeMention runs so the Enter that selected the
  // file doesn't also trigger onSubmit → submit().
  let suppressNextSubmit = false

  function reconcileMentionScroll(nextIndex: number, count: number) {
    const maxTop = Math.max(0, count - MENTION_VIEWPORT)
    setMentionScrollTop((top) => {
      let next = Math.min(top, maxTop)
      if (nextIndex < next) next = nextIndex
      else if (nextIndex >= next + MENTION_VIEWPORT) next = nextIndex - MENTION_VIEWPORT + 1
      return Math.max(0, Math.min(next, maxTop))
    })
  }

  function moveMentionSelection(delta: number) {
    const list = mentionResults()
    if (list.length === 0) return
    const raw = mentionIndex() + delta
    const next = raw < 0 ? list.length - 1 : raw >= list.length ? 0 : raw
    setMentionIndex(next)
    reconcileMentionScroll(next, list.length)
  }

  function closeMention() {
    setMentionOpen(false)
    setMentionIndex(0)
    setMentionScrollTop(0)
    setMentionResults([])
    setMentionQuery("")
    setMentionLoading(false)
    if (mentionFetchTimer) { clearTimeout(mentionFetchTimer); mentionFetchTimer = undefined }
  }

  async function runMentionSearch(query: string) {
    const seq = ++mentionFetchSeq
    setMentionLoading(true)
    try {
      const q = encodeURIComponent(query)
      const res = await sdk.fetch(sdk.url + "/find/file?query=" + q + "&limit=50")
      if (seq !== mentionFetchSeq) return   // stale
      const data = (await res.json().catch(() => [])) as unknown
      const list = Array.isArray(data) ? (data as string[]) : []
      setMentionResults(list)
      setMentionIndex(0)
      setMentionScrollTop(0)
    } catch {
      if (seq === mentionFetchSeq) setMentionResults([])
    } finally {
      if (seq === mentionFetchSeq) setMentionLoading(false)
    }
  }

  // Returns the pending @-mention token at the caret if any, else null.
  // We approximate the caret by using the end of the plainText — good enough
  // for typing at the end of the input, which is the common case.
  function detectMentionAtEnd(text: string): { start: number; query: string } | null {
    const at = text.lastIndexOf("@")
    if (at < 0) return null
    // The @ must be at start, or preceded by whitespace/newline.
    if (at > 0 && !/\s/.test(text[at - 1] ?? "")) return null
    const tail = text.slice(at + 1)
    // If any whitespace after the @, it's no longer active.
    if (/\s/.test(tail)) return null
    return { start: at, query: tail }
  }

  function completeMention() {
    const list = mentionResults()
    const pick = list[mentionIndex()]
    if (!pick) return
    const text = inputEl?.plainText ?? ""
    const m = detectMentionAtEnd(text)
    if (!m) { closeMention(); return }
    const before = text.slice(0, m.start)
    const inserted = "@" + pick + " "
    const replaced = before + inserted
    suppressNextSubmit = true
    inputEl?.setText(replaced)
    // Place caret at the end of the inserted mention (after the trailing space)
    // so the user can immediately keep typing.
    if (inputEl) inputEl.cursorOffset = replaced.length
    closeMention()
    // setText fires onContentChange which re-runs highlightMentionsInInput,
    // but call it explicitly for safety in case the event is coalesced.
    highlightMentionsInInput()
  }

  // Clears and re-adds highlights for every "@\S+" token in the input buffer.
  function highlightMentionsInInput() {
    if (!inputEl) return
    const el = inputEl
    try {
      el.clearAllHighlights()
    } catch { /* no-op if not supported */ }
    const text = el.plainText ?? ""

    // @-file mentions
    const mentionRe = /(^|\s)@\S+/g
    let m: RegExpExecArray | null
    while ((m = mentionRe.exec(text)) !== null) {
      const start = m.index + (m[1]?.length ?? 0)
      const end = start + (m[0].length - (m[1]?.length ?? 0))
      try {
        el.addHighlightByCharRange({ start, end, styleId: MENTION_STYLE_ID })
      } catch { /* no-op */ }
    }

    // Skill mentions — only highlight tokens that match a known skill name so
    // typos and unrelated slash content stay unstyled.
    const knownSkills = new Set(skills().map((s) => s.name))
    if (knownSkills.size > 0) {
      const skillRe = /(^|\s)\/([a-zA-Z0-9._-]+)/g
      let s: RegExpExecArray | null
      while ((s = skillRe.exec(text)) !== null) {
        const name = s[2]!
        if (!knownSkills.has(name)) continue
        const start = s.index + (s[1]?.length ?? 0)
        const end = start + 1 + name.length // include the leading "/"
        try {
          el.addHighlightByCharRange({ start, end, styleId: SKILL_STYLE_ID })
        } catch { /* no-op */ }
      }
    }
  }

  // Keep the selected item inside the viewport window.
  function reconcileScroll(nextIndex: number, matchCount: number) {
    const maxTop = Math.max(0, matchCount - PALETTE_VIEWPORT)
    setPaletteScrollTop((top) => {
      let next = Math.min(top, maxTop)
      if (nextIndex < next) next = nextIndex
      else if (nextIndex >= next + PALETTE_VIEWPORT) next = nextIndex - PALETTE_VIEWPORT + 1
      return Math.max(0, Math.min(next, maxTop))
    })
  }

  function moveSelection(delta: number) {
    const matches = paletteMatches()
    if (matches.length === 0) return
    const nextIndex = (() => {
      const raw = paletteIndex() + delta
      if (raw < 0) return matches.length - 1
      if (raw >= matches.length) return 0
      return raw
    })()
    setPaletteIndex(nextIndex)
    reconcileScroll(nextIndex, matches.length)
  }

  // True when a full-screen-ish modal owns the input surface — /agent, /mcp,
  // /models, /theme, or the /models API-key auth prompt. In these states we
  // suppress the slash and @ palettes because typing is either consumed by
  // the modal (MCP create wizard, models auth key) or the modal is purely
  // navigational and shouldn't stack another palette on top.
  const anyModalOpen = () =>
    agentModalOpen() || mcpModalOpen() || modelsModalOpen() || themeModalOpen() || skillsPaletteOpen() || historyGraphOpen()

  function updatePaletteFromInput() {
    const text = inputEl?.plainText ?? ""

    // Suppress both palettes while a modal owns the input.
    if (anyModalOpen()) {
      if (paletteOpen()) { setPaletteOpen(false); setPaletteIndex(0); setPaletteScrollTop(0) }
      if (mentionOpen()) closeMention()
      return
    }

    // Slash palette
    if (text.startsWith("/") && !text.includes(" ") && !text.includes("\n")) {
      setPaletteQuery(text.slice(1))
      setPaletteOpen(true)
      const matches = paletteMatches()
      const max = Math.max(0, matches.length - 1)
      const clamped = Math.min(paletteIndex(), max)
      setPaletteIndex(clamped)
      reconcileScroll(clamped, matches.length)
    } else if (paletteOpen()) {
      closePalette()
    }

    // @ mention palette
    const m = detectMentionAtEnd(text)
    if (m) {
      setMentionOpen(true)
      if (m.query !== mentionQuery()) {
        setMentionQuery(m.query)
        if (mentionFetchTimer) clearTimeout(mentionFetchTimer)
        mentionFetchTimer = setTimeout(() => { void runMentionSearch(m.query) }, 90)
      }
    } else if (mentionOpen()) {
      closeMention()
    }
  }

  function closePalette() {
    setPaletteOpen(false)
    setPaletteIndex(0)
    setPaletteScrollTop(0)
  }

  // Tab completion: insert `/name ` into input so the user can add args.
  function completeSlashCommand() {
    const match = paletteMatches()[paletteIndex()]
    if (!match) return
    inputEl?.setText("/" + match.name + " ")
    closePalette()
  }

  // ── Command status banner ───────────────────────────────────────────────
  // The bar is time-driven: statusT tracks elapsed ms since the last showStatus
  // call, and statusCharColor derives the per-char color for the current phase
  // (enter reveal → shine hold → exit wipe). See STATUS_LIFETIME_MS at the top
  // of the file for the phase timing.
  const [status, setStatus] = createSignal<{ text: string; kind: StatusKind } | undefined>()
  const [statusT, setStatusT] = createSignal(0)
  let statusRaf: ReturnType<typeof setInterval> | undefined
  function showStatus(text: string, kind: StatusKind = "info") {
    setStatus({ text, kind })
    setStatusT(0)
    if (statusRaf) clearInterval(statusRaf)
    const t0 = Date.now()
    statusRaf = setInterval(() => {
      const elapsed = Date.now() - t0
      setStatusT(elapsed)
      if (elapsed >= STATUS_LIFETIME_MS) {
        if (statusRaf) clearInterval(statusRaf)
        statusRaf = undefined
        setStatus(undefined)
      }
    }, STATUS_TICK_MS)
  }
  onCleanup(() => statusRaf && clearInterval(statusRaf))

  // ── /agent modal ────────────────────────────────────────────────────────
  // Two phases:
  //   "select" — list existing agents + "+ New agent…" row. Enter switches to
  //     the selected agent (or opens create mode).
  //   "create" — inline wizard: name → description → mode. Each Enter on the
  //     main input captures that step's value. Esc cancels.
  const [agentModalPhase, setAgentModalPhase] = createSignal<AgentPalettePhase | null>(null)
  const agentModalOpen = () => agentModalPhase() !== null

  // Built-in agents that must not be deleted. Kept in sync with
  // AgentRegistry.builtInAgents() in @gco/controller-agent.
  const BUILT_IN_AGENT_IDS = new Set([
    "build", "explore", "plan", "general", "compaction", "title", "summary",
  ])

  function buildAgentSelectItems(): AgentPaletteItem[] {
    const cur = currentAgentName()
    const items: AgentPaletteItem[] = agents().map((a) => ({
      name: a.name,
      description: a.description,
      color: a.color,
      current: a.name === cur,
      deletable: !BUILT_IN_AGENT_IDS.has(a.name),
    }))
    items.push({ name: "__new__" })
    return items
  }

  function openAgentModal() {
    const items = buildAgentSelectItems()
    const curIdx = Math.max(0, items.findIndex((it) => it.current))
    setAgentModalPhase({ type: "select", items, index: curIdx })
  }

  function closeAgentModal() {
    setAgentModalPhase(null)
  }

  function moveAgentModalSelection(delta: number) {
    const p = agentModalPhase()
    if (!p || p.type !== "select") return
    const len = p.items.length
    const next = ((p.index + delta) % len + len) % len
    setAgentModalPhase({ ...p, index: next })
  }

  async function selectAgentFromModal(name: string) {
    const list = agents()
    const idx = list.findIndex((a) => a.name === name)
    if (idx < 0) { closeAgentModal(); return }
    setAgentIndex(idx)
    const sid = sessionID()
    if (sid) {
      await sdk.client.session.update({ sessionID: sid, agent: name }).catch(() => {})
    }
    closeAgentModal()
    showStatus(`Switched to ${name}`)
  }

  function confirmAgentModalSelection() {
    const p = agentModalPhase()
    if (!p || p.type !== "select") return
    const item = p.items[p.index]
    if (!item) return
    if (item.name === "__new__") {
      setAgentModalPhase({ type: "create", step: "name" })
      inputEl?.setText("")
      return
    }
    void selectAgentFromModal(item.name)
  }

  function requestDeleteFromModal() {
    const p = agentModalPhase()
    if (!p || p.type !== "select") return
    const item = p.items[p.index]
    if (!item || item.name === "__new__") return
    if (!item.deletable) {
      showStatus(`Cannot delete built-in agent '${item.name}'`, "warn")
      return
    }
    setAgentModalPhase({ type: "confirm", name: item.name, returnIndex: p.index, items: p.items })
  }

  async function confirmDeleteFromModal() {
    const p = agentModalPhase()
    if (!p || p.type !== "confirm") return
    const name = p.name
    try {
      const res = await sdk.fetch(sdk.url + "/agent/" + encodeURIComponent(name), { method: "DELETE" })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
        showStatus(`Failed: ${err.error ?? res.statusText}`, "error")
        setAgentModalPhase({ type: "select", items: p.items, index: p.returnIndex })
        return
      }
    } catch (e) {
      showStatus(`Failed: ${String(e)}`, "error")
      setAgentModalPhase({ type: "select", items: p.items, index: p.returnIndex })
      return
    }

    // Refresh the agent list and reset selection.
    const listRes = await sdk.client.app.agents({}).catch(() => null)
    const list = (listRes?.data ?? []) as AgentEntry[]
    const primary = list.filter((a) => !a.hidden && a.mode !== "subagent")
    setAgents(primary)
    if (currentAgentName() === name) {
      const buildIdx = primary.findIndex((a) => a.name === "build")
      setAgentIndex(buildIdx >= 0 ? buildIdx : 0)
    }
    showStatus(`Deleted agent "${name}"`)

    // Rebuild the modal item list so the removed agent disappears.
    const items = buildAgentSelectItems()
    if (items.length <= 1) { closeAgentModal(); return }
    setAgentModalPhase({ type: "select", items, index: Math.min(p.returnIndex, items.length - 1) })
  }

  function cancelDeleteFromModal() {
    const p = agentModalPhase()
    if (!p || p.type !== "confirm") return
    setAgentModalPhase({ type: "select", items: p.items, index: p.returnIndex })
  }

  // ── /theme modal ────────────────────────────────────────────────────────
  const [themeModalOpen, setThemeModalOpen] = createSignal(false)
  const [themeIndex, setThemeIndex] = createSignal(0)

  const themeItems = (): ThemePaletteItem[] => {
    const items: ThemePaletteItem[] = [
      {
        name: "light",
        label: "Light",
        description: "warm cream paper — current default",
        swatchBg: LIGHT_PALETTE.bg,
        swatchFg: LIGHT_PALETTE.egg,
        current: ACTIVE_THEME === "light",
      },
      {
        name: "dark",
        label: "Dark",
        description: "beige on deep warm brown",
        swatchBg: DARK_PALETTE.bg,
        swatchFg: DARK_PALETTE.egg,
        current: ACTIVE_THEME === "dark",
      },
      {
        name: "neko-light",
        label: "Neko Light",
        description: "sakura cream with hot pink accents",
        swatchBg: NEKO_LIGHT_PALETTE.bg,
        swatchFg: NEKO_LIGHT_PALETTE.accent,
        current: ACTIVE_THEME === "neko-light",
      },
      {
        name: "neko-dark",
        label: "Neko Dark",
        description: "deep plum with bright pink accents",
        swatchBg: NEKO_DARK_PALETTE.bg,
        swatchFg: NEKO_DARK_PALETTE.accent,
        current: ACTIVE_THEME === "neko-dark",
      },
    ]
    return items
  }

  function openThemeModal() {
    const idx = themeItems().findIndex((it) => it.name === ACTIVE_THEME)
    setThemeIndex(idx >= 0 ? idx : 0)
    setThemeModalOpen(true)
  }
  function closeThemeModal() { setThemeModalOpen(false) }

  function moveThemeSelection(delta: number) {
    const items = themeItems()
    const raw = themeIndex() + delta
    const next = raw < 0 ? items.length - 1 : raw >= items.length ? 0 : raw
    setThemeIndex(next)
  }

  async function selectTheme(name: ThemeName) {
    try {
      const dir = pathMod.dirname(GLOBAL_CONFIG_PATH)
      fs.mkdirSync(dir, { recursive: true })
      let existing: Record<string, unknown> = {}
      try { existing = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, "utf8")) } catch {}
      existing.theme = name
      fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(existing, null, 2) + "\n")
    } catch (e) {
      showStatus(`Failed to save theme: ${String(e)}`, "error")
      return
    }
    closeThemeModal()
    if (name === ACTIVE_THEME) showStatus(`Theme is already ${name}`)
    else showStatus(`Theme saved (${name}) — restart to apply`, "warn")
  }

  function confirmThemeSelection() {
    const item = themeItems()[themeIndex()]
    if (!item) return
    void selectTheme(item.name)
  }

  // ── /models modal ───────────────────────────────────────────────────────
  // Grouped model catalog. Add a new provider by pushing another group; the
  // heading is rendered from `heading` and each item's `providerID/modelID`
  // is what gets persisted to neko.json.
  const STATIC_MODEL_GROUPS: ModelsPaletteGroup[] = [
    {
      providerID: "deepseek",
      heading: "deepseek",
      items: [
        { providerID: "deepseek", modelID: "deepseek-v4-flash", label: "deepseek-v4-flash" },
        { providerID: "deepseek", modelID: "deepseek-v4-pro",   label: "deepseek-v4-pro" },
      ],
    },
    {
      providerID: "anthropic",
      heading: "anthropic",
      items: [
        { providerID: "anthropic", modelID: "claude-opus-4-7",   label: "claude-opus-4-7" },
        { providerID: "anthropic", modelID: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
        { providerID: "anthropic", modelID: "claude-haiku-4-5",  label: "claude-haiku-4-5" },
      ],
    },
    {
      providerID: "openai",
      heading: "openai",
      items: [
        { providerID: "openai", modelID: "gpt-5.6",       label: "gpt-5.6" },
        { providerID: "openai", modelID: "gpt-5.4",       label: "gpt-5.4" },
        { providerID: "openai", modelID: "gpt-5.4-mini",  label: "gpt-5.4-mini" },
        { providerID: "openai", modelID: "o4-mini",       label: "o4-mini" },
      ],
    },
  ]

  const [ollamaModelItems, setOllamaModelItems] = createSignal<ModelsPaletteItem[]>([])

  const modelGroups = (): ModelsPaletteGroup[] => {
    const om = ollamaModelItems()
    if (om.length === 0) return STATIC_MODEL_GROUPS
    return [...STATIC_MODEL_GROUPS, { providerID: "ollama", heading: "ollama", items: om }]
  }

  const [modelsModalOpen, setModelsModalOpen] = createSignal(false)
  const [modelsItemIndex, setModelsItemIndex] = createSignal(0)
  const [modelsCurrentKey, setModelsCurrentKey] = createSignal<string | null>(null)
  const [modelsConnected, setModelsConnected] = createSignal<ReadonlySet<string>>(new Set())
  const [modelsAuthPrompt, setModelsAuthPrompt] = createSignal<ModelsAuthPrompt>(null)
  // When the user picks a disconnected model, we buffer it here and re-run the
  // selection once the API key is saved and the provider goes connected.
  const [modelsPendingSelection, setModelsPendingSelection] = createSignal<ModelsPaletteItem | null>(null)

  // Session-model auto-migration: when we switch to a session whose baked
  // `session.model.id` is no longer in the palette catalog (e.g. an old
  // `deepseek-chat` session after we retired that model), silently PATCH the
  // session to the config default so the next turn uses a supported model.
  // Skipped for sessions whose model is still in the catalog — they keep
  // whatever they were on (respecting per-session choices like claude).
  const migratedSessions = new Set<string>()
  createEffect(async () => {
    const sid = sessionID()
    if (!sid || migratedSessions.has(sid)) return
    migratedSessions.add(sid)
    try {
      const sRes = await sdk.client.session.get({ sessionID: sid }).catch(() => null)
      const s = sRes?.data as { model?: { id?: string; providerID?: string } } | undefined
      const currentId = s?.model?.id
      if (!currentId) return
      const validIds = new Set(
        modelGroups().flatMap((g) => g.items.map((it) => it.modelID)),
      )
      if (validIds.has(currentId)) return
      // Pick the target: config default (via modelsCurrentKey) if it's a known
      // model, otherwise the first item of the first group.
      const keyFromConfig = modelsCurrentKey()
      const fallback = modelGroups()[0]?.items[0]
      let targetProvider: string | undefined
      let targetModel: string | undefined
      if (keyFromConfig?.includes("/")) {
        const [p, m] = keyFromConfig.split("/")
        if (m && validIds.has(m)) { targetProvider = p; targetModel = m }
      }
      if (!targetModel && fallback) {
        targetProvider = fallback.providerID
        targetModel = fallback.modelID
      }
      if (!targetProvider || !targetModel) return
      await sdk.client.session
        .update({ sessionID: sid, model: { id: targetModel, providerID: targetProvider } })
        .catch(() => {})
    } catch { /* migration is best-effort — user can still pick manually via /models */ }
  })

  const decorateItem = (it: ModelsPaletteItem): ModelsPaletteItem => ({
    ...it,
    current: `${it.providerID}/${it.modelID}` === modelsCurrentKey(),
    connected: modelsConnected().has(it.providerID),
  })

  const modelsFlatItems = (): ModelsPaletteItem[] =>
    modelGroups().flatMap((g) => g.items.map(decorateItem))

  const modelsRows = (): ModelsPaletteRow[] => {
    const rows: ModelsPaletteRow[] = []
    let itemIndex = 0
    for (const group of modelGroups()) {
      rows.push({ kind: "heading", heading: group.heading, providerID: group.providerID })
      for (const it of group.items) {
        rows.push({ kind: "item", itemIndex, item: decorateItem(it) })
        itemIndex++
      }
    }
    return rows
  }

  async function openModelsModal() {
    let cfgModel: string | null = null
    try {
      // SDK wraps responses as `{ data, response }` — always unwrap `.data`.
      const cfgRes = await sdk.client.config.get({}).catch(() => null)
      const cfg = cfgRes?.data as { model?: string } | undefined
      if (cfg && typeof cfg.model === "string") cfgModel = cfg.model
    } catch {}
    let connectedSet = new Set<string>()
    try {
      const res = await sdk.client.provider.list({} as any).catch(() => null)
      const data = res?.data as {
        connected?: string[]
        providers?: Array<{ id: string; models?: Record<string, unknown> }>
      } | undefined
      const list: string[] = Array.isArray(data?.connected)
        ? data!.connected.filter((s): s is string => typeof s === "string")
        : []
      connectedSet = new Set<string>(list)
      // Refresh Ollama model list each time the modal opens.
      const ollamaData = (data?.providers ?? []).find((p) => p.id === "ollama")
      if (ollamaData && list.includes("ollama")) {
        const items: ModelsPaletteItem[] = Object.keys(ollamaData.models ?? {}).map((id) => ({
          providerID: "ollama",
          modelID: id,
          label: id,
        }))
        setOllamaModelItems(items)
      } else {
        setOllamaModelItems([])
      }
    } catch {
      connectedSet = new Set<string>()
    }
    setModelsConnected(connectedSet)
    // The server hands back its hardcoded default (deepseek/…) even when no
    // provider is set up. Only treat that as the current model if its provider
    // actually has a key — otherwise the palette would mark deepseek active on
    // a fresh install with no neko.json.
    const cfgProvider = cfgModel?.includes("/") ? cfgModel.split("/")[0] : cfgModel
    const current = cfgModel && cfgProvider && connectedSet.has(cfgProvider) ? cfgModel : null
    setModelsCurrentKey(current)
    const flat = modelsFlatItems()
    const idx = current ? flat.findIndex((it) => `${it.providerID}/${it.modelID}` === current) : -1
    setModelsItemIndex(idx >= 0 ? idx : 0)
    setModelsModalOpen(true)
  }
  function closeModelsModal() { setModelsModalOpen(false) }

  function moveModelsSelection(delta: number) {
    const total = modelsFlatItems().length
    if (total === 0) return
    const raw = modelsItemIndex() + delta
    const next = raw < 0 ? total - 1 : raw >= total ? 0 : raw
    setModelsItemIndex(next)
  }

  async function selectModel(item: ModelsPaletteItem) {
    const key = `${item.providerID}/${item.modelID}`
    try {
      await sdk.client.config.update({ config: { model: key } as any }).catch(() => {})
      const sid = sessionID()
      if (sid) {
        await sdk.client.session
          .update({ sessionID: sid, model: { id: item.modelID, providerID: item.providerID } })
          .catch(() => {})
      }
    } catch (e) {
      showStatus(`Failed to switch model: ${String(e)}`, "error")
      return
    }
    setModelsCurrentKey(key)
    closeModelsModal()
    showStatus(`Model set to ${item.label}`)
  }

  function confirmModelsSelection() {
    const item = modelsFlatItems()[modelsItemIndex()]
    if (!item) return
    // Ollama is local — no API key needed, select directly even if not in connectedSet.
    if (!item.connected && item.providerID !== "ollama") {
      setModelsPendingSelection(item)
      setModelsAuthPrompt({ providerID: item.providerID, providerLabel: item.providerID })
      inputEl?.setText("")
      return
    }
    void selectModel(item)
  }

  function cancelModelsAuthPrompt() {
    setModelsAuthPrompt(null)
    setModelsPendingSelection(null)
    inputEl?.setText("")
  }

  async function submitModelsAuthKey(rawKey: string) {
    const prompt = modelsAuthPrompt()
    const pending = modelsPendingSelection()
    if (!prompt || !pending) return
    const key = rawKey.trim()
    if (!key) {
      showStatus("API key can't be empty", "warn")
      return
    }
    try {
      await sdk.fetch(sdk.url + "/provider/" + encodeURIComponent(prompt.providerID), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      })
    } catch (e) {
      showStatus(`Failed to save key: ${String(e)}`, "error")
      return
    }
    // Refresh the connected set so the row's dot flips before we proceed.
    try {
      const res = await sdk.client.provider.list({} as any).catch(() => null)
      const data = res?.data as { connected?: string[] } | undefined
      const list: string[] = Array.isArray(data?.connected)
        ? data!.connected.filter((s): s is string => typeof s === "string")
        : []
      setModelsConnected(new Set<string>(list))
    } catch {}
    setModelsAuthPrompt(null)
    setModelsPendingSelection(null)
    inputEl?.setText("")
    await selectModel(pending)
  }

  // ── /mcp modal ──────────────────────────────────────────────────────────
  const [mcpModalPhase, setMcpModalPhase] = createSignal<McpPalettePhase | null>(null)
  const mcpModalOpen = () => mcpModalPhase() !== null

  type ServerRow = { id: string; name: string; status: string; error?: string; config: any; tools: string[] }

  function toMcpItems(list: ServerRow[]): McpPaletteItem[] {
    const items: McpPaletteItem[] = list.map((s) => {
      const cmd = Array.isArray(s.config?.command) ? s.config.command.join(" ") : undefined
      return {
        name: s.name,
        status: s.status,
        error: s.error,
        command: cmd,
        toolCount: s.tools?.length,
      }
    })
    items.push({ name: "__new__", status: "" })
    return items
  }

  async function fetchMcpList(): Promise<ServerRow[]> {
    try {
      const res = await sdk.fetch(sdk.url + "/mcp")
      const data = await res.json().catch(() => null)
      // Server wraps the array in { servers, connected } — unwrap if needed.
      if (Array.isArray(data)) return data as ServerRow[]
      if (data && typeof data === "object" && Array.isArray((data as any).servers))
        return (data as any).servers as ServerRow[]
      return []
    } catch {
      return []
    }
  }

  async function openMcpModal() {
    const list = await fetchMcpList()
    const items = toMcpItems(list)
    setMcpModalPhase({ type: "select", items, index: 0 })
  }

  function closeMcpModal() { setMcpModalPhase(null) }

  function moveMcpModalSelection(delta: number) {
    const p = mcpModalPhase()
    if (!p || p.type !== "select") return
    const len = p.items.length
    const next = ((p.index + delta) % len + len) % len
    setMcpModalPhase({ ...p, index: next })
  }

  async function reconnectMcpFromModal(name: string) {
    try {
      const res = await sdk.fetch(sdk.url + "/mcp/" + encodeURIComponent(name) + "/connect", {
        method: "POST",
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
        showStatus(`Failed: ${err.error ?? res.statusText}`, "error")
        return
      }
      showStatus(`Reconnecting "${name}"…`)
      // Give the connect a moment, then refresh.
      setTimeout(async () => {
        const list = await fetchMcpList()
        const p = mcpModalPhase()
        if (p && p.type === "select") {
          const items = toMcpItems(list)
          setMcpModalPhase({ type: "select", items, index: Math.min(p.index, items.length - 1) })
        }
      }, 400)
    } catch (e) {
      showStatus(`Failed: ${String(e)}`, "error")
    }
  }

  function confirmMcpModalSelection() {
    const p = mcpModalPhase()
    if (!p || p.type !== "select") return
    const item = p.items[p.index]
    if (!item) return
    if (item.name === "__new__") {
      setMcpModalPhase({ type: "create", step: "name" })
      inputEl?.setText("")
      return
    }
    if (item.status !== "connected") void reconnectMcpFromModal(item.name)
    else showStatus(`"${item.name}" is already connected`)
  }

  function requestDeleteMcpFromModal() {
    const p = mcpModalPhase()
    if (!p || p.type !== "select") return
    const item = p.items[p.index]
    if (!item || item.name === "__new__") return
    setMcpModalPhase({ type: "confirm", name: item.name, returnIndex: p.index, items: p.items })
  }

  async function confirmDeleteMcpFromModal() {
    const p = mcpModalPhase()
    if (!p || p.type !== "confirm") return
    const name = p.name
    try {
      const res = await sdk.fetch(sdk.url + "/mcp/" + encodeURIComponent(name), { method: "DELETE" })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
        showStatus(`Failed: ${err.error ?? res.statusText}`, "error")
        setMcpModalPhase({ type: "select", items: p.items, index: p.returnIndex })
        return
      }
    } catch (e) {
      showStatus(`Failed: ${String(e)}`, "error")
      setMcpModalPhase({ type: "select", items: p.items, index: p.returnIndex })
      return
    }
    const list = await fetchMcpList()
    const items = toMcpItems(list)
    showStatus(`Deleted MCP "${name}"`)
    if (items.length <= 1) { closeMcpModal(); return }
    setMcpModalPhase({ type: "select", items, index: Math.min(p.returnIndex, items.length - 1) })
  }

  function cancelDeleteMcpFromModal() {
    const p = mcpModalPhase()
    if (!p || p.type !== "confirm") return
    setMcpModalPhase({ type: "select", items: p.items, index: p.returnIndex })
  }

  function parseEnv(input: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const tok of input.split(/\s+/)) {
      if (!tok) continue
      const eq = tok.indexOf("=")
      if (eq <= 0) continue
      out[tok.slice(0, eq)] = tok.slice(eq + 1)
    }
    return out
  }

  async function submitNewMcp(name: string, commandLine: string, envInput: string) {
    const command = commandLine.split(/\s+/).filter(Boolean)
    const environment = parseEnv(envInput)
    const body: any = { name, type: "local", command }
    if (Object.keys(environment).length > 0) body.environment = environment
    try {
      const res = await sdk.fetch(sdk.url + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
        showStatus(`Failed: ${err.error ?? res.statusText}`, "error")
        return
      }
      showStatus(`Added MCP "${name}" — connecting…`)
      // Refresh list into select phase.
      setTimeout(async () => {
        const list = await fetchMcpList()
        const items = toMcpItems(list)
        const idx = Math.max(0, items.findIndex((it) => it.name === name))
        setMcpModalPhase({ type: "select", items, index: idx })
      }, 400)
    } catch (e) {
      showStatus(`Failed: ${String(e)}`, "error")
    }
  }

  async function submitNewAgent(name: string, description: string, mode: "primary" | "subagent" | "all") {
    try {
      const res = await sdk.fetch(sdk.url + "/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description, mode }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
        showStatus(`Failed: ${err.error ?? res.statusText}`, "error")
        return
      }
      const listRes = await sdk.client.app.agents({}).catch(() => null)
      const list = (listRes?.data ?? []) as AgentEntry[]
      const primary = list.filter((a) => !a.hidden && a.mode !== "subagent")
      if (primary.length > 0) setAgents(primary)
      showStatus(`Agent "${name}" created`)
    } catch (e) {
      showStatus(`Failed: ${String(e)}`, "error")
    }
  }

  async function cycleAgent() {
    const list = agents()
    if (list.length === 0) return
    const next = (agentIndex() + 1) % list.length
    setAgentIndex(next)
    // If a session already exists, persist the switch so the next turn uses
    // the new agent's system prompt + permission ruleset.
    const sid = sessionID()
    if (sid) {
      await sdk.client.session.update({ sessionID: sid, agent: list[next].name }).catch(() => {})
    }
  }

  function buildTranscript(): string {
    const lines: string[] = []
    for (const msgID of store.msgOrder) {
      const msg = store.msgs[msgID]
      if (!msg) continue
      lines.push(`## ${msg.role}`)
      const parts = (store.partOrder[msgID] ?? []).map((k) => store.parts[k]).filter(Boolean) as ChatPart[]
      for (const part of parts) {
        if (part.type === "text" && part.text) lines.push(part.text)
        else if (part.type === "reasoning" && part.text) lines.push(`[thinking] ${part.text}`)
        else if (part.type === "tool") {
          const inp = part.state?.input
          const io = inp ? (typeof inp === "string" ? inp : JSON.stringify(inp)) : ""
          lines.push(`[tool ${part.tool ?? ""}] ${io}`.trim())
          if (part.state?.output) lines.push(part.state.output)
        }
      }
      lines.push("")
    }
    return lines.join("\n").trim()
  }

  // Resolve the model that a fresh session should be created with. Uses the
  // user's current intent (last /models selection or config default primed on
  // mount), falling back to the palette's first entry so we never send the
  // retired `deepseek-chat` ID.
  function defaultSessionModel(): { providerID: string; id: string } {
    const key = modelsCurrentKey()
    if (key?.includes("/")) {
      const [providerID, id] = key.split("/")
      if (providerID && id) return { providerID, id }
    }
    const fallback = modelGroups()[0]?.items[0]
    return fallback
      ? { providerID: fallback.providerID, id: fallback.modelID }
      : { providerID: "deepseek", id: "deepseek-v4-flash" }
  }

  async function ensureSessionID(): Promise<string | null> {
    const existing = sessionID()
    if (existing) return existing
    // Resume the most recent session for this project rather than always creating a
    // new one. A user can start fresh explicitly with /clear.
    try {
      const listRes = await sdk.client.session.list({ limit: 1 })
      const latest = (listRes?.data as any[])?.[0]
      if (latest?.id) {
        setSessionID(String(latest.id))
        return String(latest.id)
      }
    } catch { /* fall through to create */ }
    const res = await sdk.client.session
      .create({
        agent: currentAgentName(),
        model: defaultSessionModel(),
      })
      .catch(() => null)
    const sid = res?.data?.id
    if (!sid) return null
    setSessionID(sid)
    return sid
  }

  async function clearSession() {
    const res = await sdk.client.session
      .create({
        agent: currentAgentName(),
        model: defaultSessionModel(),
      })
      .catch(() => null)
    const sid = res?.data?.id
    if (!sid) {
      showStatus("Failed to start a new session", "error")
      return
    }
    // Wipe local view state before switching so no stale messages flash.
    setStore({
      msgOrder: [],
      msgs: {},
      partOrder: {},
      parts: {},
      subagents: {},
      subagentByChildSid: {},
    })
    setLastAssistant(undefined)
    // Reset the turn-timer signals too — otherwise the "3s · N tok" line
    // from the previous session lingers below the input until the next turn.
    setTurnStart(undefined)
    setSessionID(sid)
    showStatus("Started a fresh session")
  }

  // Actual command execution — called from palette Enter, and as a two-step
  // parse in submit() for commands that take args (e.g. /rename <title>).
  async function runSlashCommand(name: string) {
    switch (name) {
      case "copy": {
        const transcript = buildTranscript()
        if (!transcript) {
          showStatus("Nothing to copy yet", "warn")
          return
        }
        await clipboardWrite(transcript)
        showStatus("Copied transcript to clipboard")
        return
      }
      case "compact": {
        const sid = sessionID()
        if (!sid) {
          showStatus("Start a session first", "warn")
          return
        }
        await sdk.client.session
          .summarize({ sessionID: sid, modelID: "deepseek-chat", providerID: "deepseek" })
          .catch(() => {})
        showStatus("Summarizing session…")
        return
      }
      case "undo": {
        const sid = sessionID()
        if (!sid) {
          showStatus("Nothing to undo", "warn")
          return
        }
        const lastUser = [...store.msgOrder].reverse().find((id) => store.msgs[id]?.role === "user")
        if (!lastUser) {
          showStatus("No user message to undo", "warn")
          return
        }
        await sdk.client.session.revert.stage({ sessionID: sid, messageID: lastUser }).catch(() => {})
        showStatus("Reverted last user message")
        return
      }
      case "redo": {
        const sid = sessionID()
        if (!sid) {
          showStatus("Nothing to redo", "warn")
          return
        }
        await sdk.client.session.unrevert({ sessionID: sid }).catch(() => {})
        showStatus("Restored reverted messages")
        return
      }
      case "rename": {
        // Two-step: insert prefix; user types title; submit() will finish it.
        inputEl?.setText("/rename ")
        showStatus("Type a new title then press Enter")
        return
      }
      case "agent": {
        openAgentModal()
        return
      }
      case "mcp": {
        void openMcpModal()
        return
      }
      case "theme": {
        openThemeModal()
        return
      }
      case "models": {
        void openModelsModal()
        return
      }
      case "clear": {
        void clearSession()
        return
      }
      case "skills": {
        openSkillsPalette()
        return
      }
      case "permission":
      case "auto": {
        togglePermissionMode()
        return
      }
      case "history": {
        openHistoryGraph()
        return
      }
      default: {
        if (isSkillName(name, skills())) {
          insertSkillMention(name)
          return
        }
        showStatus(`/${name} isn't wired up in this UI yet`, "warn")
      }
    }
  }

  /** Insert `/<name> ` as a styled mention, cursor at the end. */
  function insertSkillMention(name: string) {
    const text = `/${name} `
    inputEl?.setText(text)
    if (inputEl) inputEl.cursorOffset = text.length
    setPaletteOpen(false)
    highlightMentionsInInput()
  }

  // ── Skills palette (modal, opened by /skills) ───────────────────────────
  function openSkillsPalette() {
    if (skills().length === 0) {
      showStatus("No skills found. Create one with `neko skill create <name>`", "warn")
      return
    }
    closePalette()
    inputEl?.setText("")
    setSkillsPaletteIndex(0)
    setSkillsPaletteOpen(true)
  }
  function closeSkillsPalette() {
    setSkillsPaletteOpen(false)
    setSkillsPaletteIndex(0)
  }
  function moveSkillsPaletteSelection(delta: number) {
    const total = skillsPaletteItems().length
    if (total === 0) return
    const raw = skillsPaletteIndex() + delta
    const next = raw < 0 ? total - 1 : raw >= total ? 0 : raw
    setSkillsPaletteIndex(next)
  }
  function confirmSkillsPaletteSelection() {
    const items = skillsPaletteItems()
    const item = items[skillsPaletteIndex()]
    if (!item) return
    closeSkillsPalette()
    insertSkillMention(item.name)
  }

  // ── History graph ───────────────────────────────────────────────────────────
  function openHistoryGraph() {
    closePalette()
    inputEl?.setText("")
    setHistoryGraphIndex(0)
    setHistoryGraphOpen(true)
    void loadHistoryGraphSessions()
  }
  function closeHistoryGraph() {
    setHistoryGraphOpen(false)
    setHistoryGraphIndex(0)
  }
  function moveHistoryGraphSelection(delta: number) {
    const total = historyGraphSessions().length
    if (total === 0) return
    const next = Math.max(0, Math.min(historyGraphIndex() + delta, total - 1))
    setHistoryGraphIndex(next)
  }
  async function loadHistoryGraphSessions() {
    setHistoryGraphLoading(true)
    try {
      const res = await sdk.client.session.list({ limit: 100 })
      setHistoryGraphSessions(
        (res.data ?? []).map((s) => ({
          id: s.id,
          title: s.title || "Untitled",
          directory: s.directory,
          timeCreated: s.time.created,
          timeUpdated: s.time.updated,
          prompts: [],
          parentId: s.parentID ?? undefined,
        })),
      )
    } catch {}
    setHistoryGraphLoading(false)
  }
  async function selectHistoryGraphSession() {
    const session = historyGraphSessions()[historyGraphIndex()]
    if (!session) return
    setHistoryGraphLoading(true)
    try {
      const sameDirSessions = historyGraphSessions().filter(s => s.directory === session.directory)

      // Fetch messages for each session and build prompt entries
      const enriched = await Promise.all(
        sameDirSessions.map(async (s): Promise<GraphSessionEntry> => {
          try {
            const res = await sdk.client.session.messages({
              sessionID: s.id,
              directory: s.directory,
            })
            const messages = res.data ?? []
            const prompts: GraphPromptEntry[] = []

            type ToolPartShape = { type: "tool"; tool: string; state: { status: string; input: Record<string, unknown>; output?: string; error?: string; raw?: string } }

            for (let i = 0; i < messages.length; i++) {
              const msg = messages[i]
              if (msg.info.role !== "user") continue

              const userText = msg.parts
                .filter((p) => p.type === "text")
                .map((p) => (p as { type: "text"; text: string }).text)
                .join("")

              // Collect ALL consecutive assistant messages for this turn (until the next user message).
              // A single turn can have multiple assistant messages: one before tools run and one after.
              const responseParts: string[] = []
              const tools: GraphToolCall[] = []

              for (let j = i + 1; j < messages.length; j++) {
                const m = messages[j]
                if (m.info.role === "user") break
                if (m.info.role !== "assistant") continue

                for (const p of m.parts) {
                  if (p.type === "text") {
                    const text = (p as { type: "text"; text: string }).text.trim()
                    if (text) responseParts.push(text)
                  } else if (p.type === "tool") {
                    const tp = p as ToolPartShape
                    const inputStr = Object.keys(tp.state.input ?? {}).length > 0
                      ? JSON.stringify(tp.state.input, null, 2)
                      : (tp.state.raw ?? undefined)
                    const output = tp.state.status === "completed" ? tp.state.output
                      : tp.state.status === "error" ? tp.state.error
                      : undefined
                    tools.push({ name: tp.tool, input: inputStr || undefined, output: output || undefined })
                  }
                }
              }

              prompts.push({ text: userText, response: responseParts.join("\n\n"), tools })
            }

            return { ...s, prompts }
          } catch {
            return s
          }
        }),
      )

      const { buildProjectGraphHTML } = await import("./util/graph-html")
      const html = buildProjectGraphHTML(enriched, session.directory, session.id)
      const tmpPath = pathMod.join(os.tmpdir(), `neko-graph-${session.id}.html`)
      await Bun.write(tmpPath, html)
      const open = (await import("open")).default
      await open(tmpPath)
      closeHistoryGraph()
      showStatus(`Opened project graph for "${session.directory}"`)
    } catch (e) {
      showStatus("Failed to open graph", "warn")
    }
    setHistoryGraphLoading(false)
  }

  // Intercept up/down/tab/escape BEFORE the global keymap eats them for cursor
  // movement. Prepending on `keyInput` ensures we fire before the keymap
  // (which itself prepends). Steals keys for palette navigation while the
  // palette is open, and for agent cycling (tab/shift+tab) while it is closed.
  onMount(() => {
    const listener = (key: KeyEvent) => {
      // Pending permission prompt: y=allow once, a=always, n/esc=reject.
      // Shift+Tab flips into auto mode AND approves this request in one shot.
      // Intercept before any other modal or the textarea consumes the key.
      if (pendingPermission()) {
        if (key.name === "tab" && key.shift) {
          if (permissionMode() !== "auto") togglePermissionMode()
          replyPermission("once")
          key.preventDefault()
          return
        }
        if (key.name === "y" || key.name === "return") { replyPermission("once"); key.preventDefault(); return }
        if (key.name === "a") { replyPermission("always"); key.preventDefault(); return }
        if (key.name === "n") { replyPermission("reject"); key.preventDefault(); return }
        if (key.name === "escape") {
          const sid = sessionID()
          setPendingPermission(null)
          if (sid) void sdk.client.session.abort({ sessionID: sid }).catch(() => {})
          key.preventDefault()
          return
        }
        key.preventDefault()
        return
      }

      // Question prompt: navigate options, pick with enter/number, dismiss with esc.
      if (pendingQuestion()) {
        const qReq = pendingQuestion()!
        const tab = questionTab()
        const q = qReq.questions[tab]
        const opts = q?.options ?? []
        // Always include a custom slot at the end (index = opts.length)
        const CUSTOM_IDX = opts.length
        const total = opts.length + 1

        function pickOption(label: string) {
          const answers = qReq.questions.map((_, i) => i === tab ? [label] : (questionAnswers()[i] ?? []))
          if (qReq.questions.length === 1) {
            replyQuestion([[label]])
          } else {
            setQuestionAnswers(answers)
            if (tab < qReq.questions.length - 1) {
              setQuestionTab(tab + 1); setQuestionSelected(0)
            } else {
              replyQuestion(answers)
            }
          }
        }

        // In custom text input mode: collect chars, backspace, enter to submit, esc to cancel
        if (questionCustomMode()) {
          if (key.name === "escape") {
            setQuestionCustomMode(false)
            setQuestionCustomText("")
            key.preventDefault(); return
          }
          if (key.name === "return") {
            const text = questionCustomText().trim()
            if (text) pickOption(text)
            setQuestionCustomMode(false)
            setQuestionCustomText("")
            key.preventDefault(); return
          }
          if (key.name === "backspace" || key.name === "delete") {
            setQuestionCustomText((t) => t.slice(0, -1))
            key.preventDefault(); return
          }
          // Collect printable characters
          if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
            setQuestionCustomText((t) => t + key.sequence)
            key.preventDefault(); return
          }
          key.preventDefault(); return
        }

        if (key.name === "escape") { rejectQuestion(); key.preventDefault(); return }
        if (key.name === "up" || key.name === "k") {
          setQuestionSelected((s) => (s - 1 + total) % total)
          key.preventDefault(); return
        }
        if (key.name === "down" || key.name === "j") {
          setQuestionSelected((s) => (s + 1) % total)
          key.preventDefault(); return
        }
        if (key.name === "return") {
          const sel = questionSelected()
          if (sel === CUSTOM_IDX) {
            setQuestionCustomMode(true)
            setQuestionCustomText("")
          } else {
            const opt = opts[sel]
            if (opt) pickOption(opt.label)
          }
          key.preventDefault(); return
        }
        // Number keys: 1..opts.length pick options, last+1 opens custom
        const num = parseInt(key.name, 10)
        if (!isNaN(num) && num >= 1 && num <= total) {
          if (num === total) {
            setQuestionSelected(CUSTOM_IDX)
            setQuestionCustomMode(true)
            setQuestionCustomText("")
          } else {
            const opt = opts[num - 1]
            if (opt) pickOption(opt.label)
          }
          key.preventDefault(); return
        }
        key.preventDefault()
        return
      }

      // Theme modal open: navigate + select.
      if (themeModalOpen()) {
        if (key.name === "escape") { closeThemeModal(); key.preventDefault(); return }
        if (key.name === "up") { moveThemeSelection(-1); key.preventDefault(); return }
        if (key.name === "down") { moveThemeSelection(1); key.preventDefault(); return }
        if (key.name === "return") { confirmThemeSelection(); key.preventDefault(); return }
        return
      }

      // Models modal open: navigate + select. When the auth prompt is active,
      // let typing flow through to the input textarea; only intercept escape
      // (cancel) and return (submit via submit()).
      if (modelsModalOpen()) {
        if (modelsAuthPrompt()) {
          if (key.name === "escape") { cancelModelsAuthPrompt(); key.preventDefault(); return }
          // Enter is handled by submit() below (via the normal input path).
          return
        }
        if (key.name === "escape") { closeModelsModal(); key.preventDefault(); return }
        if (key.name === "up") { moveModelsSelection(-1); key.preventDefault(); return }
        if (key.name === "down") { moveModelsSelection(1); key.preventDefault(); return }
        if (key.name === "return") { confirmModelsSelection(); key.preventDefault(); return }
        return
      }

      // MCP modal open: intercept navigation keys.
      const mcp = mcpModalPhase()
      if (mcp) {
        if (mcp.type === "confirm") {
          if (key.name === "escape" || key.name === "n") {
            cancelDeleteMcpFromModal(); key.preventDefault(); return
          }
          if (key.name === "y" || key.name === "return") {
            void confirmDeleteMcpFromModal(); key.preventDefault(); return
          }
          key.preventDefault()
          return
        }
        if (key.name === "escape") { closeMcpModal(); key.preventDefault(); return }
        if (mcp.type === "select") {
          if (key.name === "up") { moveMcpModalSelection(-1); key.preventDefault(); return }
          if (key.name === "down") { moveMcpModalSelection(1); key.preventDefault(); return }
          if (key.name === "return") { confirmMcpModalSelection(); key.preventDefault(); return }
          if (key.name === "d") { requestDeleteMcpFromModal(); key.preventDefault(); return }
        }
        // In "create" phase, let text keys reach the input; only Esc handled above.
        return
      }

      // History graph open: navigate sessions.
      if (historyGraphOpen()) {
        if (key.name === "escape" || key.name === "q") {
          closeHistoryGraph()
          key.preventDefault(); return
        }
        if (key.name === "up" || key.name === "k") { moveHistoryGraphSelection(-1); key.preventDefault(); return }
        if (key.name === "down" || key.name === "j") { moveHistoryGraphSelection(1); key.preventDefault(); return }
        if (key.name === "return") {
          void selectHistoryGraphSession()
          key.preventDefault(); return
        }
        key.preventDefault()
        return
      }

      // Skills palette open: navigate + select.
      if (skillsPaletteOpen()) {
        if (key.name === "escape") { closeSkillsPalette(); key.preventDefault(); return }
        if (key.name === "up") { moveSkillsPaletteSelection(-1); key.preventDefault(); return }
        if (key.name === "down") { moveSkillsPaletteSelection(1); key.preventDefault(); return }
        if (key.name === "return") { confirmSkillsPaletteSelection(); key.preventDefault(); return }
        // Swallow other keys while the modal owns the input.
        key.preventDefault()
        return
      }

      // Agent modal open: intercept navigation keys.
      const modal = agentModalPhase()
      if (modal) {
        if (modal.type === "confirm") {
          if (key.name === "escape" || key.name === "n") {
            cancelDeleteFromModal()
            key.preventDefault()
            return
          }
          if (key.name === "y" || key.name === "return") {
            void confirmDeleteFromModal()
            key.preventDefault()
            return
          }
          // Swallow other keys so they don't reach the input while confirming.
          key.preventDefault()
          return
        }
        if (key.name === "escape") {
          closeAgentModal()
          key.preventDefault()
          return
        }
        if (modal.type === "select") {
          if (key.name === "up") { moveAgentModalSelection(-1); key.preventDefault(); return }
          if (key.name === "down") { moveAgentModalSelection(1); key.preventDefault(); return }
          if (key.name === "return") { confirmAgentModalSelection(); key.preventDefault(); return }
          if (key.name === "d") { requestDeleteFromModal(); key.preventDefault(); return }
        }
        // In "create" phase, let text keys reach the input; only Esc is handled.
        return
      }

      // @ mention palette open: navigate + complete. Swallow tab/return even
      // when results are empty (e.g. still loading) so Enter never accidentally
      // submits the message while the palette is up.
      if (mentionOpen()) {
        if (key.name === "escape") { closeMention(); key.preventDefault(); return }
        const list = mentionResults()
        if (key.name === "up" && list.length > 0) { moveMentionSelection(-1); key.preventDefault(); return }
        if (key.name === "down" && list.length > 0) { moveMentionSelection(1); key.preventDefault(); return }
        if (key.name === "tab" || key.name === "return") {
          if (list.length > 0) completeMention()
          key.preventDefault()
          return
        }
      }

      // Slash palette closed: esc aborts the running turn; tab cycles agents;
      // shift+tab toggles permission mode (auto <-> normal).
      if (!paletteOpen()) {
        if (key.name === "escape" && running()) {
          const sid = sessionID()
          if (sid) void sdk.client.session.abort({ sessionID: sid }).catch(() => {})
          key.preventDefault()
          return
        }
        if (key.name === "tab" && key.shift) {
          togglePermissionMode()
          key.preventDefault()
          return
        }
        if (key.name === "tab" && !key.shift) {
          void cycleAgent()
          key.preventDefault()
        }
        return
      }
      const matches = paletteMatches()
      if (key.name === "escape") {
        closePalette()
        key.preventDefault()
        return
      }
      if (matches.length === 0) return
      if (key.name === "up") {
        moveSelection(-1)
        key.preventDefault()
        return
      }
      if (key.name === "down") {
        moveSelection(1)
        key.preventDefault()
        return
      }
      if (key.name === "tab") {
        completeSlashCommand()
        key.preventDefault()
        return
      }
      if (key.name === "return") {
        const match = matches[paletteIndex()]
        closePalette()
        if (match) {
          inputEl?.setText("")
          void runSlashCommand(match.name)
        }
        key.preventDefault()
        return
      }
    }
    renderer.keyInput.prependListener("keypress", listener)
    onCleanup(() => renderer.keyInput.off("keypress", listener))
  })

  onMount(() => {
    const off = sdk.event.on("event", (rawEvent) => {
      // The SDK's Event union doesn't yet declare our custom subagent lifecycle
      // events, so widen once here for the discriminant checks below.
      const payload = rawEvent.payload as
        | typeof rawEvent.payload
        | { type: "session.subagent.spawned"; properties: Record<string, unknown> }
        | { type: "session.subagent.ended"; properties: Record<string, unknown> }

      // Subagent lifecycle — register/finalize a nested transcript keyed by
      // the spawning tool call so ToolRow can render it inline.
      if (payload.type === "session.subagent.spawned") {
        const props = payload.properties as {
          childSessionID?: string
          subagentType?: string
          toolCallID?: string
          description?: string
        }
        const tcid = props.toolCallID
        const csid = props.childSessionID
        if (!tcid || !csid) return
        if (!store.subagents[tcid]) {
          setStore("subagents", tcid, {
            childSid: csid,
            subagentType: props.subagentType ?? "subagent",
            description: props.description,
            state: "running",
            msgOrder: [],
            msgs: {},
            partOrder: {},
            parts: {},
          })
        }
        setStore("subagentByChildSid", csid, tcid)
        return
      }
      if (payload.type === "session.subagent.ended") {
        const props = payload.properties as {
          toolCallID?: string
          state?: SubagentState
        }
        const tcid = props.toolCallID
        if (!tcid || !store.subagents[tcid]) return
        setStore("subagents", tcid, "state", (props.state ?? "completed") as SubagentState)
        return
      }

      if (payload.type === "permission.asked") {
        const request = payload.properties as PermissionRequest
        if (permissionMode() === "auto") {
          void sdk.client.permission.reply({ requestID: request.id, reply: "once" }).catch(() => {})
          return
        }
        setPendingPermission(request)
        return
      }
      if (payload.type === "permission.replied") {
        const p = payload.properties as { requestID?: string }
        if (pendingPermission()?.id === p.requestID) setPendingPermission(null)
        return
      }

      if (payload.type === "question.asked") {
        const req = payload.properties as PendingQuestion
        setQuestionSelected(0)
        setQuestionTab(0)
        setQuestionAnswers(req.questions.map(() => []))
        setPendingQuestion(req)
        return
      }
      if (payload.type === "question.replied" || payload.type === "question.rejected") {
        const p = payload.properties as { requestID?: string }
        if (pendingQuestion()?.id === p.requestID) setPendingQuestion(null)
        return
      }

      if (payload.type === "message.updated") {
        const msg = payload.properties.info
        const msgSid = (msg as { sessionID?: string }).sessionID
        const currentSid = sessionID()

        // Route into nested subagent transcript if the message belongs to a
        // known child session. Otherwise, unrelated-session events are ignored.
        if (msgSid && msgSid !== currentSid) {
          const tcid = store.subagentByChildSid[msgSid]
          if (!tcid) return
          if (!store.subagents[tcid]?.msgOrder.includes(msg.id)) {
            setStore("subagents", tcid, "msgOrder", (prev) => [...(prev ?? []), msg.id])
          }
          setStore("subagents", tcid, "msgs", msg.id, {
            id: msg.id,
            role: msg.role as "user" | "assistant",
            agent: (msg as { agent?: string }).agent,
          })
          return
        }

        if (!store.msgOrder.includes(msg.id)) {
          setStore("msgOrder", (prev) => [...prev, msg.id])
        }
        setStore("msgs", msg.id, {
          id: msg.id,
          role: msg.role as "user" | "assistant",
          agent: (msg as { agent?: string }).agent,
        })

        if (msg.role === "assistant") {
          const a = msg as {
            id: string
            providerID: string
            modelID: string
            cost?: number
            time: { created: number }
            tokens: {
              input: number
              output: number
              reasoning: number
              cache: { read: number; write: number }
            }
          }
          setLastAssistant({
            id: a.id,
            timeCreated: a.time.created,
            providerID: a.providerID,
            modelID: a.modelID,
            cost: a.cost ?? 0,
            tokens: a.tokens,
          })
        }
      } else if (payload.type === "message.part.updated") {
        const part = payload.properties.part
        // Only handle text, reasoning, and tool parts
        if (part.type !== "text" && part.type !== "reasoning" && part.type !== "tool") return

        const chatPart: ChatPart = (() => {
          if (part.type === "text") {
            return {
              id: part.id,
              messageID: part.messageID,
              type: "text" as const,
              text: part.text,
            }
          }
          if (part.type === "reasoning") {
            return {
              id: part.id,
              messageID: part.messageID,
              type: "reasoning" as const,
              text: part.text,
            }
          }
          // tool
          const toolPart = part as Extract<typeof part, { type: "tool" }>
          const state = toolPart.state
          let mappedState: ChatPart["state"]
          if (state.status === "running") {
            mappedState = {
              status: "running",
              input: state.input,
              metadata: state.metadata,
            }
          } else if (state.status === "completed") {
            mappedState = {
              status: "completed",
              input: state.input,
              output: state.output,
              metadata: state.metadata,
            }
          } else if (state.status === "error") {
            mappedState = {
              status: "error",
              input: state.input,
              error: state.error,
              metadata: state.metadata,
            }
          } else {
            // pending
            mappedState = { status: "running" }
          }
          return {
            id: part.id,
            messageID: part.messageID,
            type: "tool" as const,
            tool: toolPart.tool,
            callID: toolPart.callID,
            state: mappedState,
          }
        })()

        // Route part into nested transcript if it belongs to a subagent's session
        const partSid = (part as { sessionID?: string }).sessionID
        const currentSid = sessionID()
        if (partSid && partSid !== currentSid) {
          const tcid = store.subagentByChildSid[partSid]
          if (!tcid) return
          const key = partKey(part.messageID, part.id)
          setStore("subagents", tcid, "parts", key, chatPart)
          if (!store.subagents[tcid]?.partOrder[part.messageID]?.includes(key)) {
            setStore(
              "subagents",
              tcid,
              "partOrder",
              part.messageID,
              (prev) => [...(prev ?? []), key],
            )
          }
          scrollEl?.scrollTo?.(scrollEl?.scrollHeight ?? 0)
          return
        }

        const key = partKey(part.messageID, part.id)
        setStore("parts", key, chatPart)
        if (!store.partOrder[part.messageID]?.includes(key)) {
          setStore("partOrder", part.messageID, (prev) => [...(prev ?? []), key])
        }
        scrollEl?.scrollTo?.(scrollEl?.scrollHeight ?? 0)
      } else if (payload.type === "session.status") {
        const statusType = payload.properties.status.type
        // "idle" means not running; "busy" or "retry" means active
        setRunning(statusType !== "idle")
      }
    })
    onCleanup(off)
  })

  async function submit() {
    const text = inputEl?.plainText?.trim() ?? ""
    if (running()) return

    // Models palette auth prompt: submit the typed key rather than treating it
    // as a chat message. Runs before the generic "empty input" bail so users
    // can't accidentally send an empty prompt to the LLM while the key entry
    // is focused.
    if (modelsAuthPrompt()) {
      await submitModelsAuthKey(text)
      return
    }

    // Empty input is allowed for wizard steps that accept blanks (mcp "env",
    // agent "mode" defaults). Only bail early on empty text when NO wizard is
    // active, since the actual prompt path can't send an empty message.
    const wizardActive =
      (mcpModalPhase()?.type === "create") ||
      (agentModalPhase()?.type === "create")
    if (!text && !wizardActive) return

    // MCP modal in create phase: name → command → env.
    const mcpModal = mcpModalPhase()
    if (mcpModal && mcpModal.type === "create") {
      inputEl?.setText("")
      if (mcpModal.step === "name") {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(text)) {
          showStatus("Name must match [a-zA-Z][a-zA-Z0-9_-]* — try again", "warn")
          return
        }
        setMcpModalPhase({ type: "create", step: "command", name: text })
        return
      }
      if (mcpModal.step === "command") {
        if (!text) {
          showStatus("Command is required — try again", "warn")
          return
        }
        setMcpModalPhase({ type: "create", step: "env", name: mcpModal.name, command: text })
        return
      }
      if (mcpModal.step === "env") {
        const name = mcpModal.name!
        const cmd = mcpModal.command!
        await submitNewMcp(name, cmd, text)
        return
      }
    }

    // Agent modal in create phase: intercept submit for each wizard step.
    const modal = agentModalPhase()
    if (modal && modal.type === "create") {
      inputEl?.setText("")
      if (modal.step === "name") {
        if (!/^[a-z][a-z0-9-]*$/i.test(text)) {
          showStatus("Name must match [a-zA-Z][a-zA-Z0-9-]* — try again", "warn")
          return
        }
        setAgentModalPhase({ type: "create", step: "description", name: text })
        return
      }
      if (modal.step === "description") {
        setAgentModalPhase({ type: "create", step: "mode", name: modal.name, description: text })
        return
      }
      if (modal.step === "mode") {
        const modeInput = text.toLowerCase()
        const mode = (modeInput === "subagent" || modeInput === "all" || modeInput === "primary")
          ? modeInput
          : "primary"
        const name = modal.name!
        const description = modal.description!
        closeAgentModal()
        await submitNewAgent(name, description, mode)
        return
      }
    }

    // Two-step commands: intercept `/rename <title>` and other arg-taking
    // slash commands here. Bare `/name` with no args also routes back to the
    // handler so users can type the command by hand.
    if (text.startsWith("/")) {
      const [head, ...rest] = text.split(/\s+/)
      const name = head.slice(1)
      const arg = rest.join(" ").trim()
      if (name === "rename") {
        if (!arg) {
          showStatus("Type a new title after /rename", "warn")
          return
        }
        const sid = await ensureSessionID()
        if (!sid) {
          showStatus("Failed to create session", "error")
          return
        }
        inputEl?.setText("")
        await sdk.client.session.update({ sessionID: sid, title: arg }).catch(() => {})
        showStatus(`Renamed session to "${arg}"`)
        return
      }
      // Any known slash command typed by hand with no args → run its handler.
      if (!arg && filterSlashCommands(name, skills()).some((c) => c.name === name || c.aliases?.includes(name))) {
        inputEl?.setText("")
        void runSlashCommand(name)
        return
      }
    }

    // Provider setup gate: if the current model's provider has no key
    // configured (e.g. neko.json is absent on first launch), refuse to send
    // and open /models so the user picks a provider + enters a key first.
    // Re-fetch the connected set here so a key seeded between mount and
    // submit doesn't false-block.
    const currentKey = modelsCurrentKey()
    const currentProvider = currentKey ? currentKey.split("/")[0] : null
    let connectedNow = modelsConnected()
    try {
      const res = await sdk.client.provider.list({} as any).catch(() => null)
      const data = res?.data as { connected?: string[] } | undefined
      if (Array.isArray(data?.connected)) {
        const list = data!.connected.filter((s): s is string => typeof s === "string")
        connectedNow = new Set<string>(list)
        setModelsConnected(connectedNow)
      }
    } catch { /* fall back to cached set */ }
    if (!currentProvider || !connectedNow.has(currentProvider)) {
      showStatus("Pick a provider and set up an API key before sending", "warn")
      await openModelsModal()
      return
    }

    inputEl?.setText("")
    // First real user submit — kicks the landing → chat hero transition.
    if (!hasStartedChat()) setHasStartedChat(true)
    const sid = await ensureSessionID()
    if (!sid) return
    await sdk.client.session
      .prompt({
        sessionID: sid,
        parts: [{ type: "text", text }],
      })
      .catch(() => {})
  }

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={C_BG}>
      {/* History graph (full-screen overlay, replaces chat area when open) */}
      <Show when={historyGraphOpen()}>
        <HistoryGraph
          visible={historyGraphOpen}
          loading={historyGraphLoading}
          sessions={historyGraphSessions}
          selectedIndex={historyGraphIndex}
        />
      </Show>

      {/* Messages (hidden when history graph is open) */}
      <Show when={!historyGraphOpen()}>
      <scrollbox
        ref={(r: any) => (scrollEl = r)}
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        paddingBottom={1}
        verticalScrollbarOptions={{ visible: false }}
      >
        <box height={1} />
        {/* Landing hero — sits above the input while fresh; unmounts
            immediately on send so it can't drift while the layout reflows. */}
        <Show when={!hasStartedChat()}>
          <box
            flexShrink={0}
            flexDirection={landingCompact() ? "row" : "column"}
            alignItems="center"
            justifyContent="center"
            paddingTop={landingCompact() ? 1 : 7}
            paddingBottom={1}
          >
            <box flexShrink={0} flexDirection="column">
              <For each={landingCells()}>
                {(row) => (
                  <text>
                    <For each={row}>
                      {(cell) => (
                        <span style={{ fg: rgbHex(cell.fg), bg: rgbHex(cell.bg) }}>{cell.ch}</span>
                      )}
                    </For>
                  </text>
                )}
              </For>
            </box>
            <Show when={!landingCompact()}><box height={1} /></Show>
            <Show when={landingCompact()}><box width={2} /></Show>
            <box flexShrink={0} flexDirection="column">
              <For each={nekoLandingLabel}>
                {(line) => (
                  <text fg={centerLabelColor()} attributes={TextAttributes.BOLD}>
                    {landingCompact() ? line.trim() : line}
                  </text>
                )}
              </For>
            </box>
          </box>
        </Show>
        {/* Animated neko perched on its own dark band — sits at the top of
            the scroll content so it scrolls away as the conversation grows.
            The block-letter wordmark sits at the left, both bottom-aligned so
            they perch together on the dark band. */}
        <Show when={hasStartedChat()}>
          <box flexShrink={0} flexDirection="column">
            <box
              flexShrink={0}
              flexDirection="row"
              justifyContent="space-between"
              alignItems="flex-end"
              paddingLeft={2}
              paddingRight={2}
              marginBottom={-1}
              zIndex={2000}
            >
              <box flexDirection="column" flexShrink={0} marginBottom={2}>
                <For each={nekoLabel}>
                  {(line) => (
                    <text fg={NEKO_PINK_RGBA} attributes={TextAttributes.BOLD}>
                      {line}
                    </text>
                  )}
                </For>
              </box>
              <AnimatedCat />
            </box>
            <box
              height={1}
              flexDirection="row"
              paddingLeft={2}
              paddingRight={2}
              backgroundColor={C_MUTED}
            >
              <text fg={C_DIM} attributes={TextAttributes.BOLD}>{cwdLabel}</text>
            </box>
          </box>
        </Show>
        <For each={store.msgOrder}>
          {(msgID) => (
            <MessageRow
              msgID={msgID}
              store={store}
              agentColor={agentColor}
              lookupSubagent={(callID) => store.subagents[callID]}
            />
          )}
        </For>
        <Show when={running() || streamingStats()}>
          <box paddingLeft={4} paddingTop={1} flexShrink={0} flexDirection="row" gap={2}>
            <Show when={running()}>
              <box flexDirection="row" gap={1}>
                <text>
                  <b style={{ fg: C_EGG }}>{spinnerSymbol()}</b>
                </text>
                <text>
                  {/* Index (not For) — chars in the word repeat (e.g. two "c"s in
                      "Concocting"), and For's referential-keying gets confused when
                      primitive items collide, leaving stale nodes from the prior
                      word bleeding into the new one. */}
                  <Index each={(spinnerWord() + "…").split("")}>
                    {(ch, i) => <span style={{ fg: shineColorFor(i, shinePos()) }}>{ch()}</span>}
                  </Index>
                </text>
              </box>
            </Show>
            <Show when={streamingStats()}>
              <text fg={C_DIM}>{streamingStats()}</text>
            </Show>
          </box>
        </Show>
      </scrollbox>
      </Show>

      {/* Bottom chrome — hidden entirely when the history graph is open */}
      <Show when={!historyGraphOpen()}>

      {/* Divider — doubles as the status bar. The status pill slides in flush
          against the right edge of the screen, so paddingRight is 0 to let the
          drawer effect land against the terminal boundary. */}
      <box
        height={1}
        flexDirection="row"
        justifyContent="flex-end"
        paddingLeft={2}
        paddingRight={0}
        backgroundColor={C_MUTED}
      >
        <Show when={status()}>
          {(s) => {
            const pillBgRgb = () => statusPillBgRgb(s().kind)
            // Leading pad is folded INTO the reveal cycle as prepended spaces
            // rather than a separate always-partial cell. Otherwise both the
            // cap and the pad would strobe from full → near-zero every time
            // visibleCount ticks up, giving three flashing cells per step
            // instead of two.
            const paddedText = () => " ".repeat(STATUS_PILL_PAD_LEFT) + s().text
            const paddedLen = () => paddedText().length
            const revealed = () => statusRevealCount(statusT(), paddedLen())
            const visibleCount = () => Math.ceil(revealed())
            const visible = () => paddedText().slice(paddedLen() - visibleCount())
            // Fractional part = alpha of the leading cell. Blending the cap +
            // leftmost visible cell from band bg → pill color at this alpha is
            // what turns per-cell stepping into sub-cell sliding.
            const leadAlpha = () => {
              const r = revealed()
              if (r <= 0) return 0
              const f = r - Math.floor(r)
              return f === 0 ? 1 : f
            }
            const capFg = () => rgbToHex(blendRgb(STATUS_BAND_BG, pillBgRgb(), leadAlpha()))
            // Pure helpers — all signal reads happen at the JSX call site
            // (below) so SolidJS's per-prop reactive tracking follows every
            // tick of statusT, not just once when the span was created.
            const cellFgPure = (i: number, ms: number, vc: number, lead: number, count: number) => {
              const shine = statusShineColorRgb(i, count, ms)
              const alpha = i === 0 ? lead : 1
              return rgbToHex(blendRgb(STATUS_BAND_BG, shine, alpha))
            }
            const cellBgPure = (i: number, lead: number, bg: Rgb) => {
              const alpha = i === 0 ? lead : 1
              return rgbToHex(blendRgb(STATUS_BAND_BG, bg, alpha))
            }
            const padBgHex = () => rgbToHex(pillBgRgb())
            return (
              <Show when={revealed() > 0}>
                <text attributes={TextAttributes.ITALIC | TextAttributes.BOLD}>
                  <span style={{ fg: capFg(), bg: rgbToHex(STATUS_BAND_BG) }}>{STATUS_CAP_LEFT}</span>
                  <Index each={visible().split("")}>
                    {(ch, i) => (
                      <span
                        style={{
                          fg: cellFgPure(i, statusT(), visibleCount(), leadAlpha(), visibleCount()),
                          bg: cellBgPure(i, leadAlpha(), pillBgRgb()),
                        }}
                      >
                        {ch()}
                      </span>
                    )}
                  </Index>
                  <span style={{ bg: padBgHex() }}>{" ".repeat(STATUS_PILL_PAD_RIGHT)}</span>
                </text>
              </Show>
            )
          }}
        </Show>
      </box>

      {/* Slash command palette (appears when input starts with "/") */}
      <SlashPalette
        visible={paletteOpen}
        commands={paletteMatches}
        selected={paletteIndex}
        scrollTop={paletteScrollTop}
        grouped={() => paletteQuery().trim() === ""}
      />

      {/* Skills modal (opens on /skills) */}
      <SkillsPalette
        visible={skillsPaletteOpen}
        items={skillsPaletteItems}
        index={skillsPaletteIndex}
      />

      {/* Agent modal (opens on /agent) */}
      <AgentPalette
        visible={agentModalOpen}
        phase={() => agentModalPhase() as AgentPalettePhase}
        agentColor={agentColor}
      />

      {/* MCP modal (opens on /mcp) */}
      <McpPalette
        visible={mcpModalOpen}
        phase={() => mcpModalPhase() as McpPalettePhase}
      />

      {/* Theme modal (opens on /theme) */}
      <ThemePalette
        visible={themeModalOpen}
        items={themeItems}
        index={themeIndex}
        bg={() => C_INPUT}
        border={() => C_MUTED}
        text={() => C_EGG}
        dim={() => C_DIM}
        selBg={() => C_USER_BG}
        accent={() => C_ACCENT}
      />

      {/* Models modal (opens on /models) */}
      <ModelsPalette
        visible={modelsModalOpen}
        rows={modelsRows}
        itemIndex={modelsItemIndex}
        authPrompt={modelsAuthPrompt}
        bg={() => C_INPUT}
        border={() => C_MUTED}
        text={() => C_EGG}
        dim={() => C_DIM}
        selBg={() => C_USER_BG}
        accent={() => C_ACCENT}
        active={() => C_ACTIVE}
      />

      {/* @ mention palette (appears when typing @<query> in the input) */}
      <MentionPalette
        visible={mentionOpen}
        query={mentionQuery}
        results={mentionResults}
        selected={mentionIndex}
        scrollTop={mentionScrollTop}
        loading={mentionLoading}
      />

      {/* Permission prompt (normal mode only) */}
      <Show when={pendingPermission()}>
        {(req) => (
          <box
            flexShrink={0}
            flexDirection="column"
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={C_INPUT}
          >
            <text fg={C_ACCENT} wrapMode="none" attributes={TextAttributes.BOLD}>
              {"Give permission?"}
            </text>
            <text>
              <span style={{ fg: "#22c55e", attributes: TextAttributes.BOLD }}>y</span>
              <span style={{ fg: PALETTE.dim }}>{" allow   "}</span>
              <span style={{ fg: "#ef4444", attributes: TextAttributes.BOLD }}>n</span>
              <span style={{ fg: PALETTE.dim }}>{" reject   "}</span>
              <span style={{ fg: "#f59e0b", attributes: TextAttributes.BOLD }}>a</span>
              <span style={{ fg: PALETTE.dim }}>{" always"}</span>
            </text>
          </box>
        )}
      </Show>

      {/* Question prompt */}
      <Show when={pendingQuestion()}>
        {(req) => {
          const tab = () => questionTab()
          const q = () => req().questions[tab()]
          const opts = () => q()?.options ?? []
          const sel = () => questionSelected()
          const customIdx = () => opts().length
          const isCustom = () => sel() === customIdx()
          const inCustomMode = () => questionCustomMode()
          return (
            <box
              flexShrink={0}
              flexDirection="column"
              paddingLeft={2}
              paddingRight={2}
              paddingTop={1}
              paddingBottom={1}
              backgroundColor={C_INPUT}
            >
              <text fg={C_ACCENT} wrapMode="word" attributes={TextAttributes.BOLD}>
                {q()?.question ?? ""}
              </text>
              <For each={opts()}>
                {(opt, i) => (
                  <text fg={i() === sel() ? C_EGG : C_DIM} wrapMode="word">
                    <span style={{ fg: i() === sel() ? C_ACCENT : C_DIM }}>{i() + 1}. </span>
                    {opt.label}
                    {opt.description ? <span style={{ fg: C_DIM }}>{" — " + opt.description}</span> : null}
                  </text>
                )}
              </For>
              {/* Always-visible custom slot */}
              <text fg={isCustom() ? C_EGG : C_DIM} wrapMode="word">
                <span style={{ fg: isCustom() ? C_ACCENT : C_DIM }}>{opts().length + 1}. </span>
                <Show when={inCustomMode()} fallback={"Type your own answer"}>
                  <span style={{ fg: C_EGG }}>{questionCustomText() || " "}</span>
                  <span style={{ fg: C_ACCENT }}>{"█"}</span>
                </Show>
              </text>
              <text fg={C_DIM}>
                <Show when={inCustomMode()} fallback={"↑↓ select   return pick   esc dismiss"}>
                  {"type answer   return submit   esc cancel"}
                </Show>
              </text>
            </box>
          )
        }}
      </Show>

      {/* Input */}
      <box
        flexShrink={0}
        flexDirection="row"
        alignItems="flex-start"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        backgroundColor={C_INPUT}
      >
        <text fg={agentColor(currentAgentName())} attributes={TextAttributes.BOLD}>
          {"❯ "}
        </text>
        <textarea
          ref={(el: TextareaRenderable) => {
            inputEl = el
            el?.focus()
          }}
          flexGrow={1}
          textColor={C_EGG}
          focusedTextColor={C_EGG}
          backgroundColor={C_INPUT}
          focusedBackgroundColor={C_INPUT}
          cursorColor={agentColor(currentAgentName())}
          maxHeight={8}
          syntaxStyle={INPUT_SYNTAX}
          placeholder={hasStartedChat() ? undefined : landingPlaceholder}
          placeholderColor={C_DIM}
          onContentChange={() => { updatePaletteFromInput(); highlightMentionsInInput() }}
          onSubmit={() => {
            if (suppressNextSubmit) { suppressNextSubmit = false; return }
            if (mentionOpen()) {
              if (mentionResults().length > 0) completeMention()
              return
            }
            if (paletteOpen() && paletteMatches().length > 0) {
              completeSlashCommand()
              return
            }
            void submit()
          }}
          onKeyDown={(e: KeyEvent) => {
            if (e.name === "c" && e.ctrl) {
              exit(new Error("interrupted"))
              return
            }
          }}
        />
      </box>

      {/* Landing spacer — mirrors the scrollbox's flexGrow so the input
          floats to the vertical center of the terminal during the hero
          screen; unmounts once the transition completes. */}
      <Show when={transitionT() < 1}>
        <box flexGrow={1} backgroundColor={C_BG} />
      </Show>

      {/* Agent footer — shows current agent, tab hint, and turn/context stats.
          On narrow terminals it stacks into two rows so nothing is clipped. */}
      <Show when={agents().length > 0}>
        <box
          flexShrink={0}
          flexDirection={footerNarrow() ? "column" : "row"}
          justifyContent="space-between"
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          backgroundColor={C_BG}
        >
          <box flexDirection="row">
            <text fg={agentColor(currentAgentName())} attributes={TextAttributes.BOLD}>
              {"▎ "}
              {currentAgentName()}
            </text>
            <text fg={C_DIM}>
              {"   "}
              {agents().length > 1 ? "tab · next agent" : ""}
            </text>
          </box>
          <box
            flexDirection="row"
            justifyContent="space-between"
            marginTop={footerNarrow() ? 1 : 0}
          >
            <box flexDirection="row">
              <text fg={permissionMode() === "auto" ? C_ACCENT : C_DIM}>
                {permissionMode() === "auto" ? "◆ auto" : "◇ normal"}
              </text>
              <text fg={C_DIM}>{"   shift+tab"}</text>
            </box>
            <box flexDirection="row" marginLeft={footerNarrow() ? 0 : 4}>
              <Show when={activeModelName()}>
                <text fg={C_ACTIVE}>{"● "}</text>
                <text fg={C_DIM}>{activeModelName()}</text>
              </Show>
              <Show when={contextUsage()}>
                <text fg={C_DIM}>{"   " + contextUsage()}</text>
              </Show>
            </box>
          </box>
        </box>
      </Show>

      </Show>{/* end: bottom chrome hidden when history graph is open */}
    </box>
  )
}
