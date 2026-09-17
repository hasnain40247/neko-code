export * as SlashCommand from "./slash-command"

import { Schema } from "effect"
import { optional } from "./schema"

export type Status = "active" | "todo" | "skill"

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  aliases: Schema.Array(Schema.String).pipe(optional),
  // `"active"` = a `runSlashCommand` handler exists.
  // `"skill"`  = dynamically discovered from ./skills/*.md or ~/.config/neko/skills/*.md.
  // `"todo"`   = registered for discoverability but not yet wired up.
  // Rendered as separate sections in the /-palette.
  status: Schema.Literals(["active", "todo", "skill"]).pipe(optional),
}).annotate({ identifier: "SlashCommand.Info" })

export const registry: readonly Info[] = [
  // { name: "rename",     description: "Rename the current session", status: "active" },
  // { name: "undo",       description: "Revert the previous user message", status: "active" },
  // { name: "redo",       description: "Restore a previously reverted message", status: "active" },
  { name: "compact",    description: "Summarize the session to shrink the context window", aliases: ["summarize"], status: "active" },
  { name: "thinking",   description: "Cycle assistant thinking display", aliases: ["toggle-thinking"], status: "todo" },
  { name: "copy",       description: "Copy the full session transcript to clipboard", status: "active" },
  { name: "skills",     description: "Browse skills and insert one into the prompt", status: "active" },
  { name: "agent",      description: "Create a new agent", status: "active" },
  { name: "mcp",        description: "Manage MCP servers", status: "active" },
  { name: "theme",      description: "Switch between light and dark themes", status: "active" },
  { name: "models",     description: "Switch the active model", status: "active" },
  { name: "clear",      description: "Start a fresh session (clears context and history)", status: "active" },
  { name: "permission", description: "Toggle auto-approve for tool permission prompts", aliases: ["auto"], status: "active" },
]
