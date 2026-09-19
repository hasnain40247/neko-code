import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import type { Server } from "bun"
import { startTuiServer, type TuiServerServices } from "./tui-server"

// ─── Mock services ────────────────────────────────────────────────────────────

const SESSION_ID = "sess_test_001"

const mockSession = {
  id: SESSION_ID,
  projectID: "proj_test",
  title: "Test Session",
  location: { directory: "/tmp/test" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  model: { id: "deepseek-chat", providerID: "deepseek" },
  time: { created: Date.now(), updated: Date.now() },
}

const mockServices: TuiServerServices = {
  createSession: async (input) => ({ ...mockSession, ...input, id: SESSION_ID }),
  getSession: async (id) => (id === SESSION_ID ? mockSession : null),
  listSessions: async () => [mockSession],
  prompt: async () => {},
  loadEvents: async () => [],
  archiveSession: async () => {},
  abortSession: async () => {},
  compactSession: async () => {},
  updateSession: async (_id, patch) => ({ ...mockSession, ...patch }),
  forkSession: async (_id) => ({ ...mockSession, id: "forked-session", title: "Fork" }),
  revertSession: async () => {},
  listAgents: async () => [
    { id: "build", name: "Build", description: "Build agent", mode: "primary", hidden: false },
  ],
  listSkills: async () => [],
  listTools: async () => [],
  listMcpServers: async () => [],
  listProjects: async () => [],
  addMcp: async () => ({}),
  addAgent: async () => {},
  removeAgent: async () => {},
  connectMcp: async () => {},
  disconnectMcp: async () => {},
  removeMcp: async () => {},
  listCredentials: async () => [],
  setProviderKey: async () => {},
  listQuestions: async () => [],
  replyQuestion: async () => {},
  rejectQuestion: async () => {},
  listPermissions: async () => [],
  replyPermission: async () => {},
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let server: Server<undefined>
let base: string

beforeAll(() => {
  server = startTuiServer("/tmp/test", mockServices)
  base = `http://localhost:${server.port}`
})

afterAll(() => {
  server.stop(true)
})

// ─── Helper ───────────────────────────────────────────────────────────────────

const get = (path: string) => fetch(`${base}${path}`)
const post = (path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
const patch = (path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method: "PATCH",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  })

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /global/health", () => {
  test("returns 200 OK", async () => {
    const res = await get("/global/health")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("OK")
  })
})

describe("GET /global/event (SSE)", () => {
  test("returns text/event-stream and emits server.connected", async () => {
    const res = await get("/global/event")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    // Read only the first chunk (server.connected) then abort
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    reader.cancel()
    const text = new TextDecoder().decode(value)
    expect(text).toContain("server.connected")
  })
})

describe("GET /config", () => {
  test("returns default model config", async () => {
    const res = await get("/config")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty("model")
  })
})

describe("GET /global/config", () => {
  test("same as /config", async () => {
    const res = await get("/global/config")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty("model")
  })
})

describe("PATCH /config", () => {
  test("returns 200 with merged config", async () => {
    const res = await patch("/config", { model: "deepseek/deepseek-chat" })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty("model")
  })
})

describe("PATCH /global/config", () => {
  test("returns 200 with empty body", async () => {
    const res = await patch("/global/config", {})
    expect(res.status).toBe(200)
  })
})

describe("GET /config/providers", () => {
  test("returns provider list with deepseek", async () => {
    const res = await get("/config/providers")
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(Array.isArray(body.all)).toBe(true)
    expect(body.all.some((p: any) => p.id === "deepseek")).toBe(true)
  })
})

describe("GET /provider", () => {
  test("same as /config/providers", async () => {
    const res = await get("/provider")
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty("providers")
    expect(body).toHaveProperty("default")
    expect(body).toHaveProperty("connected")
  })
})

describe("GET /provider/auth", () => {
  test("returns empty object", async () => {
    const res = await get("/provider/auth")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })
})

describe("GET /agent", () => {
  test("returns list of non-hidden agents from mock", async () => {
    const res = await get("/agent")
    expect(res.status).toBe(200)
    const body = await res.json() as any[]
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
    expect(body[0]).toHaveProperty("name")
    expect(body[0]).toHaveProperty("mode")
  })
})

describe("GET /skill", () => {
  test("returns empty array", async () => {
    const res = await get("/skill")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe("GET /session", () => {
  test("returns list of sessions from mock", async () => {
    const res = await get("/session")
    expect(res.status).toBe(200)
    const body = await res.json() as any[]
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(1)
    expect(body[0]).toHaveProperty("id")
    expect(body[0]).toHaveProperty("title")
  })
})

describe("GET /session/status", () => {
  test("returns map of sessionID to busy|idle", async () => {
    const res = await get("/session/status")
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(typeof body).toBe("object")
    expect(body[SESSION_ID]).toEqual({ type: "idle" })
  })
})

describe("POST /session", () => {
  test("creates a session and returns SDK shape", async () => {
    const res = await post("/session", {
      title: "New Session",
      model: { id: "deepseek-chat", providerID: "deepseek" },
      directory: "/tmp/test",
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty("id")
    expect(body).toHaveProperty("title")
    expect(body).toHaveProperty("model")
    expect(body.model).toHaveProperty("id")
    expect(body.model).toHaveProperty("providerID")
  })

  test("creates session without body (defaults used)", async () => {
    const res = await post("/session")
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty("id")
  })
})

describe("GET /session/:id", () => {
  test("returns session for known id", async () => {
    const res = await get(`/session/${SESSION_ID}`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.id).toBe(SESSION_ID)
  })

  test("returns 404 for unknown id", async () => {
    const res = await get("/session/nonexistent_id")
    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body).toHaveProperty("error")
  })
})

describe("POST /session/:id/prompt", () => {
  test("accepts prompt text and returns message shape", async () => {
    const res = await post(`/session/${SESSION_ID}/prompt`, {
      text: "Hello, run a quick test",
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty("id")
    expect(body).toHaveProperty("sessionID")
    expect(body.sessionID).toBe(SESSION_ID)
    expect(body).toHaveProperty("parts")
    expect(body.parts[0].text).toBe("Hello, run a quick test")
  })

  test("accepts prompt via parts array", async () => {
    const res = await post(`/session/${SESSION_ID}/prompt`, {
      parts: [{ type: "text", text: "Via parts" }],
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.parts[0].text).toBe("Via parts")
  })
})

describe("GET /session/:id/message", () => {
  test("returns empty array", async () => {
    const res = await get(`/session/${SESSION_ID}/message`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe("GET /session/:id/message/:msgId/part", () => {
  test("returns empty array", async () => {
    const res = await get(`/session/${SESSION_ID}/message/msg_001/part`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe("GET /session/:id/diff", () => {
  test("returns empty array", async () => {
    const res = await get(`/session/${SESSION_ID}/diff`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe("GET /session/:id/todo", () => {
  test("returns empty array", async () => {
    const res = await get(`/session/${SESSION_ID}/todo`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe("POST /session/:id/abort", () => {
  test("returns empty object", async () => {
    const res = await post(`/session/${SESSION_ID}/abort`, {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })
})

describe("GET /permission", () => {
  test("returns empty array", async () => {
    const res = await get("/permission")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe("GET /question", () => {
  test("returns empty array", async () => {
    const res = await get("/question")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe("GET /command", () => {
  test("returns array of command objects", async () => {
    const res = await get("/command")
    expect(res.status).toBe(200)
    const body = await res.json() as any[]
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
    expect(body[0]).toHaveProperty("name")
    expect(body[0]).toHaveProperty("description")
  })
})

describe("GET /lsp", () => {
  test("returns running status object", async () => {
    const res = await get("/lsp")
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty("running")
    expect(body.running).toBe(false)
  })
})

describe("GET /formatter", () => {
  test("returns running status object", async () => {
    const res = await get("/formatter")
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty("running")
    expect(body.running).toBe(false)
  })
})

describe("GET /mcp", () => {
  test("returns servers array and connected count", async () => {
    const res = await get("/mcp")
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty("servers")
    expect(body).toHaveProperty("connected")
    expect(Array.isArray(body.servers)).toBe(true)
  })
})

describe("GET /vcs", () => {
  test("returns 200", async () => {
    const res = await get("/vcs")
    expect(res.status).toBe(200)
  })
})

describe("GET /vcs/status", () => {
  test("returns empty array", async () => {
    const res = await get("/vcs/status")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe("GET /vcs/diff", () => {
  test("returns diff object with diff string", async () => {
    const res = await get("/vcs/diff")
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty("diff")
    expect(typeof body.diff).toBe("string")
  })
})

describe("GET /path", () => {
  test("returns path object with home, state, config, worktree, directory", async () => {
    const res = await get("/path")
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty("home")
    expect(body).toHaveProperty("state")
    expect(body).toHaveProperty("config")
    expect(body).toHaveProperty("worktree")
    expect(body).toHaveProperty("directory")
    expect(body.directory).toBe("/tmp/test")
    expect(body.state).toContain("neko")
  })
})

describe("GET /project", () => {
  test("returns array of project objects", async () => {
    const res = await get("/project")
    expect(res.status).toBe(200)
    const body = await res.json() as any[]
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
    expect(body[0]).toHaveProperty("id")
    expect(body[0]).toHaveProperty("worktree")
  })
})

describe("GET /project/current", () => {
  test("returns project object with id and worktree", async () => {
    const res = await get("/project/current")
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty("id")
    expect(body).toHaveProperty("worktree")
    expect(body.worktree).toBe("/tmp/test")
    expect(body).toHaveProperty("time")
  })
})

describe("GET /project/:id/directories", () => {
  test("returns directories array containing the working directory", async () => {
    const id = encodeURIComponent("/tmp/test")
    const res = await get(`/project/${id}/directories`)
    expect(res.status).toBe(200)
    const body = await res.json() as any[]
    expect(Array.isArray(body)).toBe(true)
    expect(body[0]).toHaveProperty("directory")
  })
})

describe("POST /global/dispose", () => {
  test("returns empty object", async () => {
    const res = await post("/global/dispose")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })
})

describe("Unknown routes", () => {
  test("GET unknown path returns 404 with error", async () => {
    const res = await get("/nonexistent/path")
    expect(res.status).toBe(404)
    const body = await res.json() as any
    expect(body).toHaveProperty("error")
  })

  test("POST unknown path returns 404", async () => {
    const res = await post("/nonexistent/path", {})
    expect(res.status).toBe(404)
  })
})
