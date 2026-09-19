import type cytoscape from 'cytoscape'
import { sesSize, sesBg, sesBorder, agentBg, agentBorder, sesT, lerpHex } from './colors'

// Cytoscape node/edge element type — the library typings use `any` for data accessors
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CyNode = cytoscape.NodeSingular & { data: (k: string) => any }

export function buildCyStyles(minCount: number, maxCount: number): cytoscape.StylesheetStyle[] {
  const sz   = (n: CyNode) => sesSize(n.data('promptCount') || 0, minCount, maxCount)
  const bg   = (n: CyNode) => sesBg(n.data('promptCount') || 0, minCount, maxCount)
  const bord = (n: CyNode) => sesBorder(n.data('promptCount') || 0, minCount, maxCount)
  const aBg  = (n: CyNode) => agentBg(n.data('promptCount') || 0, minCount, maxCount)
  const aBrd = (n: CyNode) => agentBorder(n.data('promptCount') || 0, minCount, maxCount)

  return [
    { selector: 'node', style: {
      'font-family': 'Montserrat, sans-serif',
      'font-size': 9,
      'color': '#8B7060',
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 7,
    }},
    // ── Day nodes ────────────────────────────────────────────────────────────
    { selector: 'node[type="day"]', style: {
      'shape': 'rectangle',
      'background-color': '#3A2818',
      'width': 28, 'height': 28,
      'corner-radius': 3,
      'label': (n: CyNode) => n.data('label'),
      'text-wrap': 'wrap',
      'font-size': 9,
      'font-weight': 'bold',
      'color': '#281E16',
      'text-background-color': '#E8DCC8',
      'text-background-opacity': 0.92,
      'text-background-shape': 'roundrectangle',
      'text-background-padding': '5px',
      'cursor': 'pointer',
    }},
    { selector: 'node[type="day"]:selected', style: { 'border-color': '#D46E8A', 'border-width': 3 }},
    { selector: 'node[type="day"].day-collapsed', style: {
      'shape': 'ellipse', 'width': 44, 'height': 44,
      'label': 'data(sessionCount)',
      'text-valign': 'center', 'text-halign': 'center', 'text-margin-y': 0,
      'font-size': 13, 'font-weight': '700', 'color': '#F5EDE3',
      'text-background-opacity': 0,
    }},
    // ── Session nodes ────────────────────────────────────────────────────────
    { selector: 'node[type="session"]', style: {
      'shape': 'round-rectangle',
      'corner-radius': (n: CyNode) => sz(n) * 0.30,
      'width':  sz,
      'height': sz,
      'background-color': bg,
      'border-width': 0,
      'label': '',
      'cursor': 'pointer',
    }},
    { selector: 'node[type="session"].hovered', style: {
      'border-width': 2.5,
      'border-color': bord,
    }},
    { selector: 'node[type="session"]:selected', style: {
      'border-width': 3,
      'border-color': (n: CyNode) => lerpHex('#5A8C52', '#081A0C', sesT(n.data('promptCount') || 0, minCount, maxCount)),
    }},
    // ── Agent session nodes ───────────────────────────────────────────────────
    { selector: 'node[type="session"][?isAgent]', style: {
      'background-color': aBg,
    }},
    { selector: 'node[type="session"][?isAgent].hovered', style: {
      'border-color': aBrd,
    }},
    { selector: 'node[type="session"][?isAgent]:selected', style: {
      'border-color': (n: CyNode) => lerpHex('#4A7AB0', '#080E18', sesT(n.data('promptCount') || 0, minCount, maxCount)),
    }},
    // ── Prompt nodes ─────────────────────────────────────────────────────────
    { selector: 'node[type="prompt"]', style: {
      'shape': 'ellipse',
      'background-color': '#E8A8C0',
      'background-opacity': 1,
      'border-color': '#C87898',
      'border-width': 1,
      'width': 11, 'height': 11,
      'label': '',
      'cursor': 'pointer',
      'z-index': 10,
    }},
    { selector: 'node[type="prompt"]:selected', style: {
      'background-color': '#D46E8A',
      'border-color': '#B5506A',
    }},
    { selector: 'node[type="prompt"].prompt-outlined', style: {
      'border-width': 2.5,
      'border-color': '#D46E8A',
      'border-opacity': 1,
      'background-color': '#D46E8A',
    }},
    { selector: 'node[type="prompt"].sidebar-hover', style: {
      'background-color': '#D46E8A',
      'border-color': '#B5506A',
      'border-width': 2,
      'opacity': 1,
    }},
    // ── Collapsed pill ────────────────────────────────────────────────────────
    { selector: 'node[type="collapsed"]', style: {
      'shape': 'round-rectangle',
      'background-color': '#DED0B8',
      'border-color': '#B09878',
      'border-width': 1,
      'width': 70, 'height': 22,
      'label': 'data(label)',
      'font-size': 9,
      'color': '#7A6858',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-margin-y': 0,
    }},
    // ── Edges ────────────────────────────────────────────────────────────────
    { selector: 'edge', style: {
      'width': 1.5,
      'line-color': '#7A6050',
      'target-arrow-shape': 'none',
      'curve-style': 'straight',
      'opacity': 0.8,
    }},
    { selector: 'edge[?spine]', style: {
      'width': 2.5, 'line-color': '#3A2818', 'opacity': 1,
    }},
    { selector: 'edge[?spawnEdge]', style: {
      'width': 1.5,
      'line-color': '#7898B8',
      'line-style': 'dashed',
      'line-dash-pattern': [4, 4],
      'target-arrow-shape': 'triangle',
      'target-arrow-color': '#7898B8',
      'arrow-scale': 0.8,
      'curve-style': 'straight',
      'opacity': 0.8,
    }},
    { selector: 'edge[?spawnedBy]', style: {
      'width': 1.5,
      'line-color': '#7898B8',
      'line-style': 'dashed',
      'line-dash-pattern': [4, 4],
      'target-arrow-shape': 'triangle',
      'target-arrow-color': '#7898B8',
      'arrow-scale': 0.8,
      'curve-style': 'unbundled-bezier',
      'control-point-weights': [0.5],
      'control-point-distances': [60],
      'opacity': 0.7,
    }},
    { selector: 'edge[?continuation]', style: {
      'width': 1.5,
      'line-color': '#8AAE82',
      'line-style': 'dashed',
      'line-dash-pattern': [6, 5],
      'target-arrow-shape': 'none',
      'curve-style': 'unbundled-bezier',
      'control-point-weights': [0.5],
      'control-point-distances': [-180],
      'opacity': 0.4,
    }},
    { selector: 'edge[?promptEdge]', style: {
      'width': 1, 'line-color': '#B0A492', 'opacity': 0.25, 'curve-style': 'straight',
    }},
    { selector: 'node[type="assistant"]', style: {
      'shape': 'ellipse',
      'background-color': '#DED0B8',
      'background-opacity': 1,
      'border-color': '#B09878',
      'border-width': 1.5,
      'width': 14, 'height': 14,
      'label': '',
      'cursor': 'pointer',
      'z-index': 10,
    }},
    { selector: 'node[type="assistant"]:selected', style: {
      'background-color': '#C0AB8E', 'border-color': '#8B7060',
    }},
    { selector: 'node[type="tool"]', style: {
      'shape': 'ellipse',
      'background-color': '#B8C8A0',
      'background-opacity': 1,
      'border-color': '#8AA870',
      'border-width': 1,
      'width': 9, 'height': 9,
      'label': '',
      'cursor': 'pointer',
      'z-index': 10,
    }},
    { selector: 'node[type="tool"]:selected', style: {
      'background-color': '#6A9850', 'border-color': '#3A6828',
    }},
    { selector: 'node[type="tool"].hovered', style: {
      'background-color': '#7A9860',
      'border-color': '#4A7838',
      'border-width': 1.5,
      'opacity': 1,
    }},
    { selector: 'node[type="tool"].tool-active', style: {
      'background-color': '#5A8848',
      'border-color': '#3A6828',
      'border-width': 2,
      'opacity': 1,
    }},
    { selector: 'node[type="tool"][?isAgent]', style: {
      'background-color': '#7898B8',
      'border-color': '#4A6888',
      'border-width': 1.5,
      'width': 12, 'height': 12,
      'background-opacity': 1,
    }},
    { selector: 'node[type="tool"][?isAgent].hovered', style: {
      'background-color': '#4A6888',
      'border-color': '#2A4868',
      'border-width': 2,
      'opacity': 1,
    }},
    { selector: 'node[type="tool"][?isAgent].tool-active', style: {
      'background-color': '#2A4868',
      'border-color': '#0E2848',
      'border-width': 2,
      'opacity': 1,
    }},
    { selector: 'node[type="tool"][?isMcp]', style: {
      'background-color': '#E8A888',
      'border-color': '#C07858',
      'border-width': 1.5,
      'width': 11, 'height': 11,
      'background-opacity': 1,
    }},
    { selector: 'node[type="tool"][?isMcp].hovered', style: {
      'background-color': '#D08868',
      'border-color': '#A05838',
      'border-width': 2,
      'opacity': 1,
    }},
    { selector: 'node[type="tool"][?isMcp].tool-active', style: {
      'background-color': '#B06848',
      'border-color': '#804028',
      'border-width': 2,
      'opacity': 1,
    }},
    { selector: 'edge[?asstEdge]', style: {
      'width': 1, 'line-color': '#B09878', 'opacity': 0.4, 'curve-style': 'straight',
    }},
    { selector: 'edge[?toolEdge]', style: {
      'width': 0.8, 'line-color': '#A8B898', 'opacity': 0.3, 'curve-style': 'straight',
    }},
    { selector: '.faded',       style: { 'opacity': 0.12 }},
    { selector: 'node[type="prompt"].faded', style: { 'opacity': 0.35 }},
    { selector: 'edge[?promptEdge].faded',   style: { 'opacity': 0.12 }},
    { selector: '.highlighted', style: { 'opacity': 1 }},
    { selector: 'node[type="day"].highlighted', style: {
      'border-color': '#D46E8A', 'border-width': 3, 'border-opacity': 1,
    }},
    { selector: 'node.prompt-dimmed', style: {
      'opacity': 0.32,
      'transition-property': 'opacity',
      'transition-duration': '0.18s',
      'transition-timing-function': 'ease',
    }},
    { selector: 'node.prompt-dimmed.prompt-hover', style: { 'opacity': 1 }},
    { selector: 'edge.path-active', style: {
      'line-color': '#D46E8A', 'width': 2.5, 'opacity': 0.9, 'z-index': 10,
    }},
  ] as cytoscape.StylesheetStyle[]
}
