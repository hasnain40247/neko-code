import { useRef, useState, useEffect, useCallback, RefObject } from 'react'
import cytoscape from 'cytoscape'
import type { GraphData, PromptNodeData } from '../types'
import { buildCyStyles } from '../lib/cy-styles'
import { computePromptGrid } from '../lib/layout'

// ─── Types returned from this hook ────────────────────────────────────────────

export interface SidebarSession {
  nodeID: string
  promptsData: PromptNodeData[]
}

export interface PromptTip {
  text: string
  x: number
  y: number
}

export interface ScrollTarget {
  num: number
  subType?: 'tool' | 'assistant'
  toolName?: string
  tick: number
  forceOpen?: boolean  // expand the details panel; only set for graph-originated nav
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useGraphInteractions(
  containerRef: RefObject<HTMLDivElement | null>,
  data: GraphData,
) {
  // ── React state (drives re-renders) ────────────────────────────────────────
  const [sidebarOpen,      setSidebarOpen]      = useState(false)
  const [sidebarSession,   setSidebarSession]   = useState<SidebarSession | null>(null)
  const [sidebarDayCount,  setSidebarDayCount]  = useState<number | null>(null)
  const [sessionTipVisible,setSessionTipVisible]= useState(false)
  const [promptTip,        setPromptTip]        = useState<PromptTip | null>(null)
  const [zoomPercent,      setZoomPercent]      = useState(100)
  const [activePromptDetails, setActivePromptDetails] = useState<Set<string>>(new Set())
  const [scrollTarget,     setScrollTarget]     = useState<ScrollTarget | null>(null)

  // ── Imperative refs ────────────────────────────────────────────────────────
  const cyRef                 = useRef<cytoscape.Core | null>(null)
  const expandedPromptsRef    = useRef<Record<string, cytoscape.CollectionReturnValue>>({})
  const expandedPromptDetailsRef = useRef<Record<string, cytoscape.CollectionReturnValue>>({})
  const openAgentNodesRef     = useRef<Record<string, cytoscape.CollectionReturnValue>>({})
  const removedDaysRef        = useRef<Record<string, cytoscape.CollectionReturnValue>>({})
  const savedDayPositionsRef  = useRef<Record<string, Record<string, { x: number; y: number }>>>({})
  const sbSessionNodeIDRef    = useRef<string | null>(null)
  const tipTimerRef           = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollTickRef         = useRef(0)

  // ── Helpers ────────────────────────────────────────────────────────────────
  function doScrollTo(num: number, subType?: 'tool' | 'assistant', toolName?: string, forceOpen = false) {
    scrollTickRef.current++
    setScrollTarget({ num, subType, toolName, tick: scrollTickRef.current, forceOpen })
  }

  function syncActivePromptDetails() {
    setActivePromptDetails(new Set(Object.keys(expandedPromptDetailsRef.current)))
  }

  // ── Session tip ────────────────────────────────────────────────────────────
  function showSessionTip() {
    if (tipTimerRef.current) clearTimeout(tipTimerRef.current)
    setSessionTipVisible(true)
    tipTimerRef.current = setTimeout(() => {
      setSessionTipVisible(false)
      tipTimerRef.current = null
    }, 3500)
  }

  function hideSessionTip() {
    if (tipTimerRef.current) { clearTimeout(tipTimerRef.current); tipTimerRef.current = null }
    setSessionTipVisible(false)
  }

  // ── Collapse / expand helpers ──────────────────────────────────────────────
  // Fully tear down a spawned agent session and everything inside it:
  // its prompt bubbles, their detail nodes (recursively), and the session node + spawnEdge.
  function _tearDownAgentSession(tid: string) {
    const cy = cyRef.current
    if (!cy || !openAgentNodesRef.current[tid]) return
    openAgentNodesRef.current[tid]!
      .filter('node[type="session"]')
      .forEach((agentNode: cytoscape.NodeSingular) => {
        const agentSid = agentNode.id()
        const prefix   = agentSid + '_p'
        // Collapse any open prompt details belonging to this agent session (recursive).
        Object.keys(expandedPromptDetailsRef.current).forEach(k => {
          if (k.startsWith(prefix)) collapsePromptDetail(k)
        })
        // Remove the agent session's prompt bubbles.
        if (expandedPromptsRef.current[agentSid]) {
          cy.remove(expandedPromptsRef.current[agentSid])
          delete expandedPromptsRef.current[agentSid]
        }
      })
    cy.remove(openAgentNodesRef.current[tid])
    delete openAgentNodesRef.current[tid]
  }

  function collapsePromptDetail(promptID: string) {
    const cy = cyRef.current
    if (!cy || !expandedPromptDetailsRef.current[promptID]) return
    // Recursively tear down any agent sessions spawned from isAgent tool nodes
    // before removing the detail, so nothing is left orphaned.
    expandedPromptDetailsRef.current[promptID]!
      .filter('node[type="tool"]')
      .forEach((toolNode: cytoscape.NodeSingular) => {
        if (toolNode.data('isAgent')) _tearDownAgentSession(toolNode.id())
      })
    cy.$('#' + promptID).removeClass('prompt-outlined')
    cy.remove(expandedPromptDetailsRef.current[promptID])
    delete expandedPromptDetailsRef.current[promptID]
    syncActivePromptDetails()
  }

  // Shared: build + add assistant/tool detail nodes for a prompt bubble.
  function _openPromptDetail(promptID: string) {
    const cy = cyRef.current
    if (!cy) return
    const pNode = cy.$('#' + promptID) as cytoscape.NodeSingular
    const pd    = pNode.data() as {
      sessionID: string; response: string; tools: Array<{ name: string; input?: string; output?: string }>
    }
    const px = pNode.position('x'), py = pNode.position('y')

    const sNode = cy.$('#' + pd.sessionID) as cytoscape.NodeSingular
    const dayX  = (cy.$('#' + sNode.data('dayID')) as cytoscape.NodeSingular).position('x')
    const spx   = sNode.position('x'), spy = sNode.position('y')
    const rLen  = Math.sqrt((spx - dayX) ** 2 + spy ** 2) || 1
    const ox = (spx - dayX) / rLen, oy = spy / rLen
    const lx = -oy, ly = ox

    const ASST_DIST = 36, TOOL_DIST = 30, TOOL_SPREAD = 18
    const asstId = promptID + '_asst'
    const asstX  = px + ox * ASST_DIST, asstY = py + oy * ASST_DIST

    const els: cytoscape.ElementDefinition[] = []
    els.push({ data: { id: asstId, type: 'assistant', text: pd.response || '', promptID },
               position: { x: asstX, y: asstY } })
    els.push({ data: { id: asstId + '_e', source: promptID, target: asstId, asstEdge: true } })

    const tools = pd.tools || []
    const n     = tools.length
    tools.forEach((tool, ti) => {
      const lat      = (ti - (n - 1) / 2) * TOOL_SPREAD
      const tid      = asstId + '_t' + ti
      const toolName = typeof tool === 'string' ? tool : (tool.name || 'tool')
      const toolInp  = typeof tool === 'object' ? (tool.input  || '') : ''
      const toolOut  = typeof tool === 'object' ? (tool.output || '') : ''
      const isAgent  = /agent/i.test(toolName)
      els.push({ data: { id: tid, type: 'tool', name: toolName, input: toolInp, output: toolOut, promptID, isAgent },
                 position: { x: asstX + ox * TOOL_DIST + lx * lat, y: asstY + oy * TOOL_DIST + ly * lat } })
      els.push({ data: { id: tid + '_e', source: asstId, target: tid, toolEdge: true } })
    })

    expandedPromptDetailsRef.current[promptID] = cy.add(els)
    expandedPromptDetailsRef.current[promptID]!.removeClass('faded').addClass('highlighted')
    cy.$('#' + promptID).addClass('prompt-outlined')
    syncActivePromptDetails()
  }

  // For regular session prompts: collapses all other open details first.
  function togglePromptDetail(promptID: string) {
    const wasOpen = !!expandedPromptDetailsRef.current[promptID]
    Object.keys(expandedPromptDetailsRef.current).forEach(k => collapsePromptDetail(k))
    if (wasOpen) {
      Object.keys(expandedPromptsRef.current).forEach(sid => {
        if (expandedPromptsRef.current[sid]) {
          expandedPromptsRef.current[sid]!.removeClass('faded').addClass('highlighted')
        }
      })
      return
    }
    _openPromptDetail(promptID)
  }

  // For agent session prompts: does NOT collapse other open details.
  // Collapsing the parent's detail would remove the agent tool node whose
  // connected spawnEdge holds the agent session in place.
  function toggleAgentPromptDetail(promptID: string) {
    if (expandedPromptDetailsRef.current[promptID]) {
      collapsePromptDetail(promptID)
      return
    }
    _openPromptDetail(promptID)
  }

  function collapsePrompts(sessionID: string) {
    const cy = cyRef.current
    if (!cy || !expandedPromptsRef.current[sessionID]) return
    // Only collapse detail nodes that belong to this session's own prompts.
    // Closing details from other sessions (e.g. the parent that spawned this
    // agent session) would remove their tool node and cause Cytoscape to
    // auto-remove the spawnEdge connecting to this agent session.
    const prefix = sessionID + '_p'
    Object.keys(expandedPromptDetailsRef.current).forEach(k => {
      if (k.startsWith(prefix)) collapsePromptDetail(k)
    })
    cy.remove(expandedPromptsRef.current[sessionID])
    delete expandedPromptsRef.current[sessionID]
  }

  function addPromptBubbles(sessionID: string) {
    const cy = cyRef.current
    if (!cy) return
    const sNode = cy.$('#' + sessionID) as cytoscape.NodeSingular
    const pd = (sNode.data('promptsData') || []) as PromptNodeData[]
    if (!pd.length) return

    const needsComputed = pd[0]!.gx === 0 && pd[0]!.gy === 0
    const computedGrid  = needsComputed
      ? computePromptGrid(sNode.position('x'), sNode.position('y'), sNode.data('dayX') || 0, pd.length)
      : null

    const els: cytoscape.ElementDefinition[] = []
    pd.forEach((p, pi) => {
      const pid = sessionID + '_p' + p.num
      const gx  = computedGrid ? computedGrid[pi]!.gx : p.gx
      const gy  = computedGrid ? computedGrid[pi]!.gy : p.gy
      els.push({ data: { id: pid, type: 'prompt', text: p.text, response: p.response, tools: p.tools, promptNum: p.num, sessionID },
                 position: { x: gx, y: gy } })
      els.push({ data: { id: sessionID + '_pe' + p.num, source: sessionID, target: pid, promptEdge: true } })
    })
    expandedPromptsRef.current[sessionID] = cy.add(els)
  }

  function togglePrompts(sessionID: string) {
    const cy = cyRef.current
    if (!cy) return
    const wasOpen = !!expandedPromptsRef.current[sessionID]
    Object.keys(expandedPromptsRef.current).forEach(k => {
      collapsePrompts(k)
      if (k !== sessionID) {
        cy.$('#' + k).removeClass('highlighted').addClass('faded')
      }
    })
    if (wasOpen) return
    addPromptBubbles(sessionID)
  }

  function toggleAgentPrompts(sessionID: string) {
    if (expandedPromptsRef.current[sessionID]) {
      collapsePrompts(sessionID)
      return
    }
    addPromptBubbles(sessionID)
  }

  function toggleDay(dayID: string) {
    const cy = cyRef.current
    if (!cy) return
    const dayNode = cy.$('#' + dayID) as cytoscape.NodeSingular

    if (removedDaysRef.current[dayID]) {
      const restored = cy.add(removedDaysRef.current[dayID])
      delete removedDaysRef.current[dayID]
      dayNode.removeClass('day-collapsed')
      const dpos    = dayNode.position()
      const origins = savedDayPositionsRef.current[dayID] || {}
      delete savedDayPositionsRef.current[dayID]
      restored.filter('node[type="session"]').forEach(n => {
        const target = origins[n.id()] || { x: n.position('x'), y: n.position('y') }
        n.position({ x: dpos.x, y: dpos.y })
        n.style('opacity', 0)
        n.animate(
          { position: target, style: { opacity: 1 } },
          { duration: 300, easing: 'ease-out-cubic' },
        )
      })
    } else {
      cy.nodes('[dayID="' + dayID + '"]').forEach(n => collapsePrompts(n.id()))
      const branch = cy.nodes('[dayID="' + dayID + '"]')
      if (branch.length === 0) { dayNode.addClass('day-collapsed'); return }
      const origins: Record<string, { x: number; y: number }> = {}
      branch.forEach(n => { origins[n.id()] = { x: n.position('x'), y: n.position('y') } })
      savedDayPositionsRef.current[dayID] = origins
      const dpos = dayNode.position()
      let left   = branch.length
      branch.forEach(n => {
        n.animate(
          { position: { x: dpos.x, y: dpos.y }, style: { opacity: 0 } },
          { duration: 260, easing: 'ease-in-quad', complete: () => {
            left--
            if (left === 0) {
              removedDaysRef.current[dayID] = cy.remove(branch.union(branch.connectedEdges()))
              dayNode.addClass('day-collapsed')
            }
          }},
        )
      })
    }
  }

  // ── Sidebar helpers ─────────────────────────────────────────────────────────
  function renderSidebar(sessionNodeID: string) {
    const cy = cyRef.current
    if (!cy) return
    const sNode = cy.$('#' + sessionNodeID) as cytoscape.NodeSingular
    if (sNode.empty()) return
    const pd = (sNode.data('promptsData') || []) as PromptNodeData[]
    sbSessionNodeIDRef.current = sessionNodeID
    setSidebarSession({ nodeID: sessionNodeID, promptsData: pd })
  }

  function openSidebar(nodeData: Record<string, unknown>) {
    const cy = cyRef.current
    if (!cy) return

    if (nodeData['type'] === 'day') {
      setSidebarDayCount(nodeData['sessionCount'] as number)
      setSidebarSession(null)
      sbSessionNodeIDRef.current = null
      setSidebarOpen(true)
      return
    }

    let sessionNodeID: string | null = null
    let scrollToNum: number | null   = null
    let subType: 'tool' | 'assistant' | undefined
    let toolName: string | undefined

    if (nodeData['type'] === 'session') {
      sessionNodeID = nodeData['id'] as string
    } else if (nodeData['type'] === 'prompt') {
      sessionNodeID = nodeData['sessionID'] as string
      scrollToNum   = nodeData['promptNum'] as number
    } else if (nodeData['type'] === 'assistant') {
      const pNode = cy.$('#' + nodeData['promptID']) as cytoscape.NodeSingular
      if (!pNode.empty()) {
        sessionNodeID = pNode.data('sessionID')
        scrollToNum   = pNode.data('promptNum')
        subType       = 'assistant'
      }
    } else if (nodeData['type'] === 'tool') {
      const pNode = cy.$('#' + nodeData['promptID']) as cytoscape.NodeSingular
      if (!pNode.empty()) {
        sessionNodeID = pNode.data('sessionID')
        scrollToNum   = pNode.data('promptNum')
        subType       = 'tool'
        toolName      = nodeData['name'] as string
      }
    }

    if (!sessionNodeID) { setSidebarOpen(true); return }
    if (sessionNodeID !== sbSessionNodeIDRef.current) renderSidebar(sessionNodeID)
    setSidebarDayCount(null)
    setSidebarOpen(true)
    if (scrollToNum != null) doScrollTo(scrollToNum, subType, toolName, subType === 'tool')
  }

  // ── Highlight chain ─────────────────────────────────────────────────────────
  function highlightChain(node: cytoscape.NodeSingular) {
    const cy = cyRef.current
    if (!cy) return
    // Focus is shifting — clear any persistent tool selection.
    cy.nodes('.tool-active').removeClass('tool-active')
    let chain     = cy.collection().add(node)
    let pathEdges = cy.collection()

    if (node.data('type') === 'day') {
      node.connectedEdges().not('[?spine]').not('[?continuation]').forEach(e => {
        if (e.source().id() === node.id()) chain = chain.add(e).add(e.target())
      })
    }

    let current = node
    for (let i = 0; i < 10; i++) {
      const inEdge = current.connectedEdges()
        .not('[?spine]').not('[?continuation]')
        .filter(e => (e as cytoscape.EdgeSingular).target().id() === current.id())
      if (inEdge.empty()) break
      const parent = (inEdge.first() as cytoscape.EdgeSingular).source() as cytoscape.NodeSingular
      chain     = chain.add(inEdge).add(parent)
      pathEdges = pathEdges.add(inEdge)
      current   = parent
    }

    // Keep expanded prompt bubbles visible for all sessions — but when clicking
    // a prompt, skip its own session's sibling bubbles so they fade out (same
    // behaviour as tool siblings when a tool is selected).
    const clickedPromptSID = node.data('type') === 'prompt'
      ? (node.data('sessionID') as string | undefined)
      : null
    Object.keys(expandedPromptsRef.current).forEach(sid => {
      const sn = cy.$('#' + sid) as cytoscape.NodeSingular
      if (!sn.empty()) chain = chain.add(sn)
      if (expandedPromptsRef.current[sid] && sid !== clickedPromptSID) {
        chain = chain.add(expandedPromptsRef.current[sid])
      }
    })

    // When clicking an assistant node, keep all sibling detail nodes visible.
    // Skip this for tool nodes — adding the full collection would re-highlight
    // sibling tools, making it impossible to distinguish which one was selected.
    const detailPromptID = node.data('promptID') as string | undefined
    if (detailPromptID && node.data('type') !== 'tool' && expandedPromptDetailsRef.current[detailPromptID]) {
      chain = chain.add(expandedPromptDetailsRef.current[detailPromptID])
    }

    cy.edges('.path-active').removeClass('path-active')
    cy.elements().removeStyle('opacity')
    cy.elements().addClass('faded').removeClass('highlighted')
    chain.removeClass('faded').addClass('highlighted')
    pathEdges.addClass('path-active')
    // Re-assert full opacity for hovered/active tool nodes — removeStyle() above
    // wiped any previous inline override and class-based opacity:1 loses to .faded
    // when rules appear earlier in the stylesheet.
    cy.nodes('.hovered, .tool-active').style('opacity', 1)
  }

  // ── Agent session pop-out ───────────────────────────────────────────────────
  function toggleAgentSession(toolNode: cytoscape.NodeSingular) {
    const cy = cyRef.current
    if (!cy) return
    const tid = toolNode.id()
    if (openAgentNodesRef.current[tid]) {
      _tearDownAgentSession(tid)
      return
    }

    const promptNode  = cy.$('#' + toolNode.data('promptID')) as cytoscape.NodeSingular
    const sessionNode = promptNode.empty() ? null : cy.$('#' + promptNode.data('sessionID')) as cytoscape.NodeSingular
    const parentRealId = sessionNode && !sessionNode.empty() ? sessionNode.data('sessionId') as string : null

    const dayX = sessionNode ? (cy.$('#' + sessionNode.data('dayID')) as cytoscape.NodeSingular).position('x') : 0
    const spx  = sessionNode ? sessionNode.position('x') : toolNode.position('x')
    const spy  = sessionNode ? sessionNode.position('y') : toolNode.position('y')
    const rLen = Math.sqrt((spx - dayX) ** 2 + spy ** 2) || 1
    const ox   = (spx - dayX) / rLen, oy = spy / rLen
    const tp   = toolNode.position()
    const AGENT_DIST = 48
    const ax = tp.x + ox * AGENT_DIST, ay = tp.y + oy * AGENT_DIST

    // Strategy 1: session already in orbit
    const toolOut  = toolNode.data('output') as string || ''
    const idMatch  = toolOut.match(/<task id="([^"]+)"/)
    const childSid = idMatch ? idMatch[1] : null
    if (childSid) {
      const orbitNode = cy.nodes('[sessionId="' + childSid + '"]') as cytoscape.NodeCollection
      if (!orbitNode.empty()) {
        const spawnEdgeId = tid + '_spawn_orbit'
        if (cy.$('#' + spawnEdgeId).empty()) {
          const edgeEl = cy.add({ data: { id: spawnEdgeId, source: tid, target: orbitNode.first().id(), spawnEdge: true } })
          openAgentNodesRef.current[tid] = edgeEl
        }
        highlightChain(toolNode)
        orbitNode.removeClass('faded').addClass('highlighted')
        openSidebar(orbitNode.data() as Record<string, unknown>)
        return
      }
    }

    // Strategy 2: pop-out
    if (!parentRealId) return
    const agentSessions = data.agentMap[parentRealId]
    if (!agentSessions || !agentSessions.length) return

    const agentSession = agentSessions[0]!
    const agentNodeId  = tid + '_agent_session'

    const agentEls = cy.add([
      { data: { id: agentNodeId, type: 'session', isAgent: true,
                title: agentSession.title, sessionId: agentSession.sessionId,
                promptCount: agentSession.promptCount, promptsData: agentSession.promptsData,
                dayID: sessionNode ? sessionNode.data('dayID') : '', dayX, sesNum: 0,
                firstPrompt: agentSession.title },
        position: { x: ax, y: ay } },
      { data: { id: agentNodeId + '_e', source: tid, target: agentNodeId, spawnEdge: true } },
    ])
    openAgentNodesRef.current[tid] = agentEls
    highlightChain(toolNode)
    agentEls.removeClass('faded').addClass('highlighted')
    openSidebar((agentEls.filter('node').first() as cytoscape.NodeSingular).data() as Record<string, unknown>)
  }

  // ── Callbacks exposed to UI components ─────────────────────────────────────
  const closeSidebar = useCallback(() => {
    const cy = cyRef.current
    if (cy) cy.nodes(':selected').unselect()
    sbSessionNodeIDRef.current = null
    setSidebarOpen(false)
  }, [])

  const zoomStep = useCallback((factor: number) => {
    const cy = cyRef.current
    if (!cy) return
    const z = Math.max(0.05, Math.min(5, cy.zoom() * factor))
    cy.zoom({ level: z, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } })
  }, [])

  const onSidebarPromptHover = useCallback((num: number) => {
    const cy = cyRef.current
    const sid = sbSessionNodeIDRef.current
    if (!cy || !sid) return
    const pid = sid + '_p' + num
    const pn  = cy.$('#' + pid) as cytoscape.NodeSingular
    if (!pn.empty()) { pn.addClass('sidebar-hover'); pn.style('opacity', 1) }
  }, [])

  const onSidebarPromptLeave = useCallback(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.nodes('.sidebar-hover').forEach(n => { n.removeStyle('opacity'); n.removeClass('sidebar-hover') })
  }, [])

  const onSidebarPromptSelect = useCallback((num: number) => {
    const cy  = cyRef.current
    const sid = sbSessionNodeIDRef.current
    if (!cy || !sid) return
    const pid   = sid + '_p' + num
    const pn    = cy.$('#' + pid) as cytoscape.NodeSingular
    if (pn.empty()) return
    const sNode = cy.$('#' + sid) as cytoscape.NodeSingular
    const agentPrompt = !sNode.empty() && !!sNode.data('isAgent')
    highlightChain(pn)
    if (agentPrompt) toggleAgentPromptDetail(pid)
    else             togglePromptDetail(pid)
    doScrollTo(num)
    syncActivePromptDetails()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onToolHover = useCallback((promptNum: number, toolIndex: number) => {
    const cy  = cyRef.current
    const sid = sbSessionNodeIDRef.current
    if (!cy || !sid) return
    const nid = `${sid}_p${promptNum}_asst_t${toolIndex}`
    const n   = cy.$('#' + nid) as cytoscape.NodeSingular
    if (!n.empty()) { n.addClass('hovered'); n.style('opacity', 1) }
  }, [])

  const onToolLeave = useCallback(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.nodes('[type="tool"].hovered').forEach((n: cytoscape.NodeSingular) => {
      n.removeClass('hovered')
      if (!n.hasClass('tool-active')) n.removeStyle('opacity')
    })
  }, [])

  const onToolClick = useCallback((promptNum: number, toolIndex: number) => {
    const cy  = cyRef.current
    const sid = sbSessionNodeIDRef.current
    if (!cy || !sid) return
    const nid      = `${sid}_p${promptNum}_asst_t${toolIndex}`
    const toolNode = cy.$('#' + nid) as cytoscape.NodeSingular
    // Clear old selection even when the new node doesn't exist yet.
    if (toolNode.empty()) { cy.nodes('.tool-active').removeClass('tool-active'); return }
    if (toolNode.data('isAgent')) {
      toggleAgentSession(toolNode)
    } else {
      highlightChain(toolNode)         // clears .tool-active from everything first
      toolNode.addClass('tool-active') // then mark this one as active
      toolNode.style('opacity', 1)     // inline override beats .faded
      doScrollTo(promptNum, 'tool', toolNode.data('name') as string, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Main setup effect ───────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Compute min/max prompt counts for the colour scale
    const sesEls  = (data.elements as Array<{ data?: { type?: string; promptCount?: number } }>)
      .filter(e => e.data?.type === 'session')
    const counts  = sesEls.map(e => e.data?.promptCount ?? 0)
    const minCount = counts.length ? Math.min(...counts) : 0
    const maxCount = counts.length ? Math.max(...counts) : 1

    const cy = cytoscape({
      container,
      elements: data.elements as cytoscape.ElementDefinition[],
      style:    buildCyStyles(minCount, maxCount),
      layout:   { name: 'preset', fit: true, padding: 80 } as cytoscape.PresetLayoutOptions,
      userZoomingEnabled: true,
      userPanningEnabled: true,
      minZoom:  0.05,
      maxZoom:  5,
    })
    cy.zoom(1)
    cy.center()
    cyRef.current = cy

    // ── Event handlers ────────────────────────────────────────────────────────
    cy.on('tap', 'node[type="day"]', e => {
      highlightChain(e.target as cytoscape.NodeSingular)
      toggleDay(e.target.id())
    })

    cy.on('tap', 'node[type="session"]', e => {
      const target = e.target as cytoscape.NodeSingular
      if (target.data('isAgent')) {
        target.connectedEdges('[?spawnEdge]').addClass('path-active')
        target.removeClass('faded').addClass('highlighted')
        toggleAgentPrompts(target.id())
        openSidebar(target.data() as Record<string, unknown>)
        return
      }
      highlightChain(target)
      togglePrompts(target.id())
      openSidebar(target.data() as Record<string, unknown>)
      showSessionTip()

      const sidebarW   = 390 + 16 + 16
      const rp         = target.renderedPosition()
      const availW     = cy.width() - sidebarW
      const dx         = availW / 2 - rp.x
      const dy         = cy.height() / 2 - rp.y
      const pan        = cy.pan()
      cy.animate({ pan: { x: pan.x + dx, y: pan.y + dy }, duration: 300, easing: 'ease-out-cubic' })
    })

    cy.on('tap', 'node[type="prompt"]', e => {
      const target     = e.target as cytoscape.NodeSingular
      const sessionID  = target.data('sessionID') as string
      const sNode      = cy.$('#' + sessionID) as cytoscape.NodeSingular
      const agentPrompt = !sNode.empty() && !!sNode.data('isAgent')
      highlightChain(target)
      if (agentPrompt) toggleAgentPromptDetail(target.id())
      else             togglePromptDetail(target.id())
      openSidebar(target.data() as Record<string, unknown>)
    })

    cy.on('tap', 'node[type="assistant"]', e => {
      const target = e.target as cytoscape.NodeSingular
      highlightChain(target)
      openSidebar(target.data() as Record<string, unknown>)
    })

    cy.on('tap', 'node[type="tool"]', e => {
      const target = e.target as cytoscape.NodeSingular
      if (target.data('isAgent')) { toggleAgentSession(target); return }
      highlightChain(target)
      openSidebar(target.data() as Record<string, unknown>)
    })

    cy.on('tap', e => {
      if (e.target !== cy) return
      Object.keys(expandedPromptDetailsRef.current).forEach(k => collapsePromptDetail(k))
      Object.keys(expandedPromptsRef.current).forEach(k => collapsePrompts(k))
      Object.keys(openAgentNodesRef.current).forEach(k => _tearDownAgentSession(k))
      cy.edges('.path-active').removeClass('path-active')
      cy.elements().removeClass('faded highlighted tool-active')
      hideSessionTip()
      setSidebarOpen(false)
      sbSessionNodeIDRef.current = null
    })

    cy.on('mouseover', 'node[type="session"]', e => (e.target as cytoscape.NodeSingular).addClass('hovered'))
    cy.on('mouseout',  'node[type="session"]', e => (e.target as cytoscape.NodeSingular).removeClass('hovered'))
    cy.on('mouseover', 'node[type="tool"]', e => {
      const n = e.target as cytoscape.NodeSingular
      n.addClass('hovered')
      n.style('opacity', 1)
    })
    cy.on('mouseout', 'node[type="tool"]', e => {
      const n = e.target as cytoscape.NodeSingular
      n.removeClass('hovered')
      if (!n.hasClass('tool-active')) n.removeStyle('opacity')
    })
    cy.on('mouseover', 'node[type="prompt"]',  e => {
      const n = e.target as cytoscape.NodeSingular
      n.addClass('sidebar-hover')
      n.style('opacity', 1)
    })
    cy.on('mouseout', 'node[type="prompt"]', e => {
      const n = e.target as cytoscape.NodeSingular
      n.removeStyle('opacity')
      n.removeClass('sidebar-hover')
    })

    // Prompt tooltip
    function firstWords(text: string, n: number): string {
      if (!text) return ''
      const w = text.trim().split(/\s+/)
      return w.slice(0, n).join(' ') + (w.length > n ? '…' : '')
    }

    cy.on('mouseover', 'node[type="prompt"]', e => {
      const target = e.target as cytoscape.NodeSingular
      const text   = firstWords(target.data('text') as string, 10)
      if (!text) return
      const rp   = target.renderedPosition()
      const rect = cy.container()!.getBoundingClientRect()
      setPromptTip({ text, x: rect.left + rp.x + 14, y: rect.top + rp.y - 38 })
    })
    cy.on('mouseout', 'node[type="prompt"]', () => setPromptTip(null))

    cy.on('mouseover', 'node[type="tool"]', e => {
      const target = e.target as cytoscape.NodeSingular
      const name   = target.data('name') as string
      if (!name) return
      const rp   = target.renderedPosition()
      const rect = cy.container()!.getBoundingClientRect()
      setPromptTip({ text: name, x: rect.left + rp.x + 14, y: rect.top + rp.y - 38 })
    })
    cy.on('mouseout', 'node[type="tool"]', () => setPromptTip(null))

    cy.on('tap zoom pan', () => setPromptTip(null))

    // Zoom display
    cy.on('zoom', () => setZoomPercent(Math.round(cy.zoom() * 100)))
    setZoomPercent(Math.round(cy.zoom() * 100))

    // ── Focus session logic ───────────────────────────────────────────────────
    const focusId = data.focusSessionId
    if (focusId) {
      let allSesNodes = cy.nodes('[sessionId="' + focusId + '"]')
        .sort((a, b) => {
          const aIdx = (cy.$('#' + a.data('dayID')) as cytoscape.NodeSingular).data('dayIdx') || 0
          const bIdx = (cy.$('#' + b.data('dayID')) as cytoscape.NodeSingular).data('dayIdx') || 0
          return aIdx - bIdx
        })

      if (allSesNodes.empty()) {
        const agentData = (data.agentMap[focusId] || [])[0]
        if (agentData) {
          allSesNodes = cy.nodes('[sessionId="' + agentData.parentSessionId + '"]')
            .sort((a, b) => {
              const aIdx = (cy.$('#' + a.data('dayID')) as cytoscape.NodeSingular).data('dayIdx') || 0
              const bIdx = (cy.$('#' + b.data('dayID')) as cytoscape.NodeSingular).data('dayIdx') || 0
              return aIdx - bIdx
            })
        }
      }

      if (!allSesNodes.empty()) {
        const originSes    = allSesNodes[0]!
        const focusSes     = allSesNodes[allSesNodes.length - 1]!
        const originDay    = cy.$('#' + originSes.data('dayID')) as cytoscape.NodeSingular
        const focusDay     = cy.$('#' + focusSes.data('dayID'))  as cytoscape.NodeSingular
        const originDayIdx = (originDay.data('dayIdx') || 0) as number
        const focusDayIdx  = (focusDay.data('dayIdx')  || 0) as number
        const pathColor    = '#D46E8A'

        highlightChain(originDay)

        for (let di = originDayIdx + 1; di <= focusDayIdx; di++) {
          cy.$('#sp_' + di).style({ 'line-color': pathColor, 'width': 3, 'opacity': 1 })
        }
        allSesNodes.forEach(n => {
          n.style({ 'border-color': pathColor, 'border-width': 3 })
          cy.$('#e_d_' + n.id()).style({ 'line-color': pathColor, 'width': 2.5, 'opacity': 1 })
        })
        cy.edges('[?continuation]').forEach(e => {
          if (e.source().data('sessionId') === focusId) {
            e.style({ 'line-color': pathColor, 'opacity': 0.9, 'width': 2.5 })
          }
        })

        const centreEles = originDay.union(originSes).union(originDay.connectedEdges().not('[?spine]'))
        cy.animate({ center: { eles: centreEles }, duration: 700, easing: 'ease-in-out-cubic' })
      }
    }

    return () => {
      cy.destroy()
      cyRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    sidebarOpen,
    sidebarSession,
    sidebarDayCount,
    sessionTipVisible,
    promptTip,
    zoomPercent,
    activePromptDetails,
    scrollTarget,
    closeSidebar,
    zoomStep,
    onSidebarPromptHover,
    onSidebarPromptLeave,
    onSidebarPromptSelect,
    onToolHover,
    onToolLeave,
    onToolClick,
  }
}
