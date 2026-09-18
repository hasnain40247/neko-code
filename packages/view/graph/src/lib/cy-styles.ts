import type cytoscape from 'cytoscape'
import { sesSize, sesBg, sesBorder, agentBg, agentBorder, sesT, lerpHex } from './colors'

// Cytoscape node/edge element type — the library typings use `any` for data accessors
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CyNode = cytoscape.NodeSingular & { data: (k: string) => any }

export function buildCyStyles(minCount: number, maxCount: number, isDark = false): cytoscape.StylesheetStyle[] {
  const t    = (n: CyNode) => sesT(n.data('promptCount') || 0, minCount, maxCount)
  const sz   = (n: CyNode) => sesSize(n.data('promptCount') || 0, minCount, maxCount)
  const bg   = isDark
    ? (n: CyNode) => lerpHex('#4A6858', '#8ACCA0', t(n))
    : (n: CyNode) => sesBg(n.data('promptCount') || 0, minCount, maxCount)
  const bord = isDark
    ? (n: CyNode) => lerpHex('#2A4838', '#5AA870', t(n))
    : (n: CyNode) => sesBorder(n.data('promptCount') || 0, minCount, maxCount)
  const aBg  = isDark
    ? (n: CyNode) => lerpHex('#2A4068', '#5888B8', t(n))
    : (n: CyNode) => agentBg(n.data('promptCount') || 0, minCount, maxCount)
  const aBrd = isDark
    ? (n: CyNode) => lerpHex('#1A2848', '#3A6898', t(n))
    : (n: CyNode) => agentBorder(n.data('promptCount') || 0, minCount, maxCount)

  const D = isDark

  return [
    { selector: 'node', style: {
      'font-family': 'Montserrat, sans-serif',
      'font-size': 9,
      'color': D ? '#A89880' : '#8B7060',
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 7,
    }},
    // ── Day nodes ────────────────────────────────────────────────────────────
    { selector: 'node[type="day"]', style: {
      'shape': 'rectangle',
      'background-color': D ? '#2A1A0C' : '#3A2818',
      'width': 28, 'height': 28,
      'corner-radius': 3,
      'label': (n: CyNode) => n.data('label'),
      'text-wrap': 'wrap',
      'font-size': 9,
      'font-weight': 'bold',
      'color': D ? '#E8DCC8' : '#281E16',
      'text-background-color': D ? '#1A1208' : '#E8DCC8',
      'text-background-opacity': 0.92,
      'text-background-shape': 'roundrectangle',
      'text-background-padding': '5px',
      'cursor': 'pointer',
    }},
    { selector: 'node[type="day"]:selected', style: { 'border-color': D ? '#E080A0' : '#D46E8A', 'border-width': 3 }},
    { selector: 'node[type="day"].day-collapsed', style: {
      'shape': 'ellipse', 'width': 44, 'height': 44,
      'label': 'data(sessionCount)',
      'text-valign': 'center', 'text-halign': 'center', 'text-margin-y': 0,
      'font-size': 13, 'font-weight': '700', 'color': D ? '#E8DCC8' : '#F5EDE3',
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
      'border-color': D
        ? (n: CyNode) => lerpHex('#7ABE88', '#1A3C22', sesT(n.data('promptCount') || 0, minCount, maxCount))
        : (n: CyNode) => lerpHex('#5A8C52', '#081A0C', sesT(n.data('promptCount') || 0, minCount, maxCount)),
    }},
    // ── Agent session nodes ───────────────────────────────────────────────────
    { selector: 'node[type="session"][?isAgent]', style: {
      'background-color': aBg,
    }},
    { selector: 'node[type="session"][?isAgent].hovered', style: {
      'border-color': aBrd,
    }},
    { selector: 'node[type="session"][?isAgent]:selected', style: {
      'border-color': D
        ? (n: CyNode) => lerpHex('#6A9AD8', '#1A2A3C', sesT(n.data('promptCount') || 0, minCount, maxCount))
        : (n: CyNode) => lerpHex('#4A7AB0', '#080E18', sesT(n.data('promptCount') || 0, minCount, maxCount)),
    }},
    // ── Prompt nodes ─────────────────────────────────────────────────────────
    { selector: 'node[type="prompt"]', style: {
      'shape': 'ellipse',
      'background-color': D ? '#C87898' : '#E8A8C0',
      'background-opacity': 1,
      'border-color': D ? '#9A5878' : '#C87898',
      'border-width': 1,
      'width': 11, 'height': 11,
      'label': '',
      'cursor': 'pointer',
      'z-index': 10,
    }},
    { selector: 'node[type="prompt"]:selected', style: {
      'background-color': D ? '#E080A0' : '#D46E8A',
      'border-color':     D ? '#C06080' : '#B5506A',
    }},
    { selector: 'node[type="prompt"].prompt-outlined', style: {
      'border-width': 2.5,
      'border-color': D ? '#E080A0' : '#D46E8A',
      'border-opacity': 1,
      'background-color': D ? '#E080A0' : '#D46E8A',
    }},
    { selector: 'node[type="prompt"].sidebar-hover', style: {
      'background-color': D ? '#E080A0' : '#D46E8A',
      'border-color':     D ? '#C06080' : '#B5506A',
      'border-width': 2,
      'opacity': 1,
    }},
    // ── Collapsed pill ────────────────────────────────────────────────────────
    { selector: 'node[type="collapsed"]', style: {
      'shape': 'round-rectangle',
      'background-color': D ? '#2A2018' : '#DED0B8',
      'border-color':     D ? '#4A3828' : '#B09878',
      'border-width': 1,
      'width': 70, 'height': 22,
      'label': 'data(label)',
      'font-size': 9,
      'color': D ? '#9A8870' : '#7A6858',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-margin-y': 0,
    }},
    // ── Edges ────────────────────────────────────────────────────────────────
    { selector: 'edge', style: {
      'width': 1.5,
      'line-color': D ? '#9A8870' : '#7A6050',
      'target-arrow-shape': 'none',
      'curve-style': 'straight',
      'opacity': D ? 0.7 : 0.8,
    }},
    { selector: 'edge[?spine]', style: {
      'width': 2.5, 'line-color': D ? '#C8B8A0' : '#3A2818', 'opacity': D ? 0.85 : 1,
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
      'opacity': D ? 0.5 : 0.4,
    }},
    { selector: 'edge[?promptEdge]', style: {
      'width': 1, 'line-color': D ? '#8A7868' : '#B0A492', 'opacity': D ? 0.35 : 0.25, 'curve-style': 'straight',
    }},
    { selector: 'node[type="assistant"]', style: {
      'shape': 'ellipse',
      'background-color': D ? '#3A2E22' : '#DED0B8',
      'background-opacity': 1,
      'border-color': D ? '#5A4838' : '#B09878',
      'border-width': 1.5,
      'width': 14, 'height': 14,
      'label': '',
      'cursor': 'pointer',
      'z-index': 10,
    }},
    { selector: 'node[type="assistant"]:selected', style: {
      'background-color': D ? '#5A4030' : '#C0AB8E',
      'border-color':     D ? '#8A6050' : '#8B7060',
    }},
    { selector: 'node[type="tool"]', style: {
      'shape': 'ellipse',
      'background-color': D ? '#4A7838' : '#B8C8A0',
      'background-opacity': 1,
      'border-color': D ? '#2A5820' : '#8AA870',
      'border-width': 1,
      'width': 9, 'height': 9,
      'label': '',
      'cursor': 'pointer',
      'z-index': 10,
    }},
    { selector: 'node[type="tool"]:selected', style: {
      'background-color': D ? '#7ABE60' : '#6A9850',
      'border-color':     D ? '#4A9840' : '#3A6828',
    }},
    { selector: 'node[type="tool"].hovered', style: {
      'background-color': D ? '#8ACA70' : '#7A9860',
      'border-color':     D ? '#5AAA50' : '#4A7838',
      'border-width': 1.5,
      'opacity': 1,
    }},
    { selector: 'node[type="tool"].tool-active', style: {
      'background-color': D ? '#6AB858' : '#5A8848',
      'border-color':     D ? '#48A038' : '#3A6828',
      'border-width': 2,
      'opacity': 1,
    }},
    { selector: 'node[type="tool"][?isAgent]', style: {
      'background-color': D ? '#5878A8' : '#7898B8',
      'border-color':     D ? '#2A4878' : '#4A6888',
      'border-width': 1.5,
      'width': 12, 'height': 12,
      'background-opacity': 1,
    }},
    { selector: 'node[type="tool"][?isAgent].hovered', style: {
      'background-color': D ? '#6A88B8' : '#4A6888',
      'border-color':     D ? '#3A5898' : '#2A4868',
      'border-width': 2,
      'opacity': 1,
    }},
    { selector: 'node[type="tool"][?isAgent].tool-active', style: {
      'background-color': D ? '#4A68A8' : '#2A4868',
      'border-color':     D ? '#2A4888' : '#0E2848',
      'border-width': 2,
      'opacity': 1,
    }},
    { selector: 'edge[?asstEdge]', style: {
      'width': 1, 'line-color': D ? '#8A7058' : '#B09878', 'opacity': D ? 0.5 : 0.4, 'curve-style': 'straight',
    }},
    { selector: 'edge[?toolEdge]', style: {
      'width': 0.8, 'line-color': D ? '#7A9868' : '#A8B898', 'opacity': D ? 0.4 : 0.3, 'curve-style': 'straight',
    }},
    { selector: '.faded',       style: { 'opacity': D ? 0.15 : 0.12 }},
    { selector: 'node[type="prompt"].faded', style: { 'opacity': D ? 0.4 : 0.35 }},
    { selector: 'edge[?promptEdge].faded',   style: { 'opacity': D ? 0.15 : 0.12 }},
    { selector: '.highlighted', style: { 'opacity': 1 }},
    { selector: 'node[type="day"].highlighted', style: {
      'border-color': D ? '#E080A0' : '#D46E8A', 'border-width': 3, 'border-opacity': 1,
    }},
    { selector: 'node.prompt-dimmed', style: {
      'opacity': 0.32,
      'transition-property': 'opacity',
      'transition-duration': '0.18s',
      'transition-timing-function': 'ease',
    }},
    { selector: 'node.prompt-dimmed.prompt-hover', style: { 'opacity': 1 }},
    { selector: 'edge.path-active', style: {
      'line-color': D ? '#E080A0' : '#D46E8A', 'width': 2.5, 'opacity': 0.9, 'z-index': 10,
    }},
  ] as cytoscape.StylesheetStyle[]
}
