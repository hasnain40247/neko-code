export interface GraphData {
  elements: object[]
  agentMap: Record<string, AgentSessionData[]>
  title: string
  directory: string
  focusSessionId: string | null
  catGifBase64: string | null
}

export interface AgentSessionData {
  sessionId: string
  parentSessionId: string
  title: string
  promptCount: number
  promptsData: PromptNodeData[]
}

export interface PromptNodeData {
  text: string
  response: string
  tools: GraphToolCall[]
  num: number
  gx: number
  gy: number
}

export type GraphToolCall = { name: string; input?: string; output?: string }
