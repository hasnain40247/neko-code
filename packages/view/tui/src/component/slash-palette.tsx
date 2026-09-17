import { For, Show, type Accessor } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { SlashCommand as SlashCommandSchema } from "@gco/schema"
import {
  C_OVERLAY_BG as C_BG,
  C_OVERLAY_BORDER as C_BORDER,
  C_OVERLAY_TEXT as C_TEXT,
  C_OVERLAY_DIM as C_DIM,
  C_OVERLAY_SELECT as C_SEL_BG,
  C_OVERLAY_ACCENT as C_ACCENT,
} from "../palette"

export type SlashCommand = SlashCommandSchema.Info
export type SkillEntry = { readonly name: string; readonly description: string }

// Ordering in grouped mode: Active → Skills. Alphabetical inside each.
const statusRank = (c: SlashCommand): number => {
  if (c.status === "skill") return 1
  return 0
}

/** Merge the static schema registry with runtime-discovered skills, excluding todo placeholders. */
function buildCommands(skills: readonly SkillEntry[]): SlashCommand[] {
  const skillCmds: SlashCommand[] = skills.map((s) => ({
    name: s.name,
    description: s.description || "Skill from ./skills or ~/.config/neko/skills",
    status: "skill" as const,
  }))
  return [...SlashCommandSchema.registry.filter((c) => c.status !== "todo"), ...skillCmds]
}

export function filterSlashCommands(
  query: string,
  skills: readonly SkillEntry[] = [],
): SlashCommand[] {
  const all = buildCommands(skills)
  const q = query.trim().toLowerCase()
  if (!q) {
    return all.sort(
      (a, b) => statusRank(a) - statusRank(b) || a.name.localeCompare(b.name),
    )
  }

  const matches: Array<{ cmd: SlashCommand; score: number }> = []
  for (const cmd of all) {
    const names = [cmd.name, ...(cmd.aliases ?? [])]
    let best = -1
    for (const n of names) {
      const lower = n.toLowerCase()
      if (lower === q) best = Math.max(best, 3)
      else if (lower.startsWith(q)) best = Math.max(best, 2)
      else if (lower.includes(q)) best = Math.max(best, 1)
    }
    if (best >= 0) matches.push({ cmd, score: best })
  }
  matches.sort((a, b) => b.score - a.score || a.cmd.name.localeCompare(b.cmd.name))
  return matches.map((m) => m.cmd)
}

/** True if `name` refers to a runtime-discovered skill (not a builtin). */
export function isSkillName(name: string, skills: readonly SkillEntry[]): boolean {
  return skills.some((s) => s.name === name)
}

export const PALETTE_VIEWPORT = 8

// A rendered row is either a section heading (non-selectable) or a command.
// `itemIndex` on `cmd` rows lines up with the selection index kept in app.tsx,
// so the flat command index passed in via `selected` still works.
type Row =
  | { kind: "heading"; label: string }
  | { kind: "cmd"; cmd: SlashCommand; itemIndex: number }

export function SlashPalette(props: {
  visible: Accessor<boolean>
  commands: Accessor<SlashCommand[]>
  selected: Accessor<number>
  scrollTop: Accessor<number>
  /** When true, insert "Active" / "To do" headings and render everything (no
   *  windowing). Should be true only when the query is empty. */
  grouped: Accessor<boolean>
  maxNameWidth?: number
}) {
  const namePad = () => {
    if (props.maxNameWidth) return props.maxNameWidth
    let max = 0
    for (const c of props.commands()) if (c.name.length > max) max = c.name.length
    return max + 1
  }

  const rows = (): Row[] => {
    const cmds = props.commands()
    if (!props.grouped()) {
      return cmds.map((cmd, i) => ({ kind: "cmd" as const, cmd, itemIndex: i }))
    }
    const active: Row[] = []
    const skills: Row[] = []
    cmds.forEach((cmd, i) => {
      const row = { kind: "cmd" as const, cmd, itemIndex: i }
      if (cmd.status === "skill") skills.push(row)
      else active.push(row)
    })
    const out: Row[] = []
    if (active.length > 0) {
      out.push({ kind: "heading", label: "Active" })
      out.push(...active)
    }
    if (skills.length > 0) {
      out.push({ kind: "heading", label: "Skills" })
      out.push(...skills)
    }
    return out
  }

  // Grouped mode renders everything (max ~18 rows). Flat mode still windows.
  const windowed = () => {
    const rs = rows()
    if (props.grouped()) return rs
    return rs.slice(props.scrollTop(), props.scrollTop() + PALETTE_VIEWPORT)
  }
  const showMoreAbove = () => !props.grouped() && props.scrollTop() > 0
  const showMoreBelow = () =>
    !props.grouped() &&
    props.scrollTop() + PALETTE_VIEWPORT < props.commands().length

  return (
    <Show when={props.visible()}>
      <box
        flexShrink={0}
        flexDirection="column"
        border={true}
        borderColor={C_BORDER}
        backgroundColor={C_BG}
        marginBottom={0}
      >
        <Show
          when={props.commands().length > 0}
          fallback={
            <box paddingLeft={1} paddingRight={1}>
              <text fg={C_DIM}>No matching commands</text>
            </box>
          }
        >
          <Show when={showMoreAbove()}>
            <box paddingLeft={1} paddingRight={1}>
              <text fg={C_DIM}>↑ {props.scrollTop()} more</text>
            </box>
          </Show>
          <For each={windowed()}>
            {(row) => {
              if (row.kind === "heading") {
                return (
                  <box flexDirection="row" paddingLeft={1} paddingRight={1} marginTop={1}>
                    <text fg={C_ACCENT} attributes={TextAttributes.BOLD}>
                      {row.label}
                    </text>
                  </box>
                )
              }
              const isSel = () => row.itemIndex === props.selected()
              return (
                <box
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={isSel() ? C_SEL_BG : undefined}
                >
                  <text fg={C_TEXT} flexShrink={0}>
                    {("/" + row.cmd.name).padEnd(namePad() + 1)}
                  </text>
                  <text fg={C_DIM} wrapMode="none">
                    {row.cmd.description}
                  </text>
                </box>
              )
            }}
          </For>
          <Show when={showMoreBelow()}>
            <box paddingLeft={1} paddingRight={1}>
              <text fg={C_DIM}>↓ {props.commands().length - props.scrollTop() - PALETTE_VIEWPORT} more</text>
            </box>
          </Show>
        </Show>
        <box paddingLeft={1} paddingRight={1}>
          <text fg={C_DIM}>↑↓ navigate · tab/enter complete · esc dismiss</text>
        </box>
      </box>
    </Show>
  )
}
