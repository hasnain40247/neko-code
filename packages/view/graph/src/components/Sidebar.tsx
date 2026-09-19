import React, { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PromptNodeData, GraphToolCall } from '../types'
import type { ScrollTarget } from '../hooks/useGraphInteractions'

interface SidebarSession {
  nodeID: string
  promptsData: PromptNodeData[]
}

interface SidebarProps {
  open: boolean
  daySessionCount: number | null
  session: SidebarSession | null
  scrollTarget: ScrollTarget | null
  activePromptDetails: Set<string>
  onClose: () => void
  onPromptHover: (num: number) => void
  onPromptLeave: () => void
  onPromptSelect: (num: number) => void
  onToolHover: (promptNum: number, toolIndex: number) => void
  onToolLeave: () => void
  onToolClick: (promptNum: number, toolIndex: number) => void
}

function ToolBlock({
  tool,
  onHover,
  onLeave,
  onClick,
}: {
  tool: GraphToolCall
  onHover: () => void
  onLeave: () => void
  onClick: () => void
}) {
  const name       = typeof tool === 'string' ? tool : (tool.name || 'tool')
  const inp        = typeof tool === 'object' ? tool.input     : undefined
  const out        = typeof tool === 'object' ? tool.output    : undefined
  const mcpServer  = typeof tool === 'object' ? tool.mcpServer : undefined
  const hasContent = !!(inp || out)

  const nameRow = (
    <>
      <span className="chat-tool-name">{name}</span>
      {mcpServer && <span className="chat-tool-mcp-tag">{mcpServer}</span>}
    </>
  )

  if (!hasContent) {
    return (
      <div
        className="chat-tool-block chat-tool-block-flat"
        data-tool={name}
        onMouseEnter={onHover}
        onMouseLeave={onLeave}
        onClick={onClick}
      >
        {nameRow}
      </div>
    )
  }

  return (
    <details
      className="chat-tool-block"
      data-tool={name}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
    >
      <summary onClick={onClick}>
        {nameRow}
      </summary>
      <div className="chat-tool-io">
        {inp && <><div className="chat-tool-io-lbl">Input</div><pre className="chat-tool-code">{inp}</pre></>}
        {out && <><div className="chat-tool-io-lbl">Output</div><pre className="chat-tool-code">{out}</pre></>}
      </div>
    </details>
  )
}

function fmtTime(raw?: number): string {
  if (!raw) return ''
  const ms = raw > 1e13 ? Math.floor(raw / 1000) : raw
  if (ms <= 0) return ''
  const d   = new Date(ms)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + '  ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function ChatTurnGroup({
  p,
  onMouseEnter,
  onMouseLeave,
  onSelect,
  isActive,
  onToolHover,
  onToolLeave,
  onToolClick,
}: {
  p: PromptNodeData
  onMouseEnter: () => void
  onMouseLeave: () => void
  onSelect: () => void
  isActive: boolean
  onToolHover: (toolIndex: number) => void
  onToolLeave: () => void
  onToolClick: (toolIndex: number) => void
}) {
  const timeLabel = fmtTime(p.time)
  return (
    <div
      className="chat-turn-group"
      id={'sb-msg-' + p.num}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {p.text && (
        <>
          <button
            className={'prompt-sel-btn' + (isActive ? ' active' : '')}
            onClick={e => { e.stopPropagation(); onSelect() }}
          />
          <div className="chat-turn">
            <div className="chat-lbl">
              User
              {timeLabel && <span className="chat-turn-time">{timeLabel}</span>}
            </div>
            <div className="chat-bubble chat-bubble-user">{p.text}</div>
          </div>
        </>
      )}
      {p.tools && p.tools.length > 0 && (
        <div className="chat-turn">
          <div className="chat-lbl">Tool calls</div>
          <div className="chat-tools">
            {p.tools.map((t, ti) => (
              <ToolBlock
                key={ti}
                tool={t}
                onHover={() => onToolHover(ti)}
                onLeave={onToolLeave}
                onClick={() => onToolClick(ti)}
              />
            ))}
          </div>
        </div>
      )}
      {p.response && (
        <div className="chat-turn">
          <div className="chat-lbl">Assistant</div>
          <div className="chat-bubble chat-bubble-asst chat-bubble-md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{p.response}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}

export function Sidebar({
  open,
  daySessionCount,
  session,
  scrollTarget,
  activePromptDetails,
  onClose,
  onPromptHover,
  onPromptLeave,
  onPromptSelect,
  onToolHover,
  onToolLeave,
  onToolClick,
}: SidebarProps) {
  const sbBodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!scrollTarget || !sbBodyRef.current) return
    const body = sbBodyRef.current

    requestAnimationFrame(() => {
      const el = body.querySelector<HTMLElement>('#sb-msg-' + scrollTarget.num)
      if (!el) return
      body.querySelectorAll('.sb-active').forEach(n => n.classList.remove('sb-active'))
      body.querySelectorAll('.sb-item-active').forEach(n => n.classList.remove('sb-item-active'))
      el.classList.add('sb-active')
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      if (scrollTarget.subType === 'tool' && scrollTarget.toolName) {
        const toolEl = el.querySelector<HTMLElement>('[data-tool="' + scrollTarget.toolName.replace(/"/g, '\\"') + '"]')
        if (toolEl) {
          toolEl.classList.add('sb-item-active')
          if (scrollTarget.forceOpen) (toolEl as HTMLDetailsElement).open = true
        }
      } else if (scrollTarget.subType === 'assistant') {
        const asstEl = el.querySelector('.chat-bubble-asst')
        if (asstEl) asstEl.classList.add('sb-item-active')
      }
    })
  }, [scrollTarget?.tick])

  return (
    <div id="sidebar" className={open ? 'open' : ''}>
      <div id="sb-head">
        <button id="sb-close" onClick={onClose}>×</button>
      </div>
      <div id="sb-body" ref={sbBodyRef}>
        {daySessionCount !== null && session === null && (
          <div className="sb-section">
            <div className="sbl">Sessions</div>
            <div className="sbp">
              {daySessionCount} session{daySessionCount !== 1 ? 's' : ''}
            </div>
          </div>
        )}
        {session !== null && session.promptsData.length === 0 && (
          <div className="sbp" style={{ color: 'var(--text-dim)', padding: '8px 0' }}>
            No messages
          </div>
        )}
        {session !== null && session.promptsData.length > 0 && session.promptsData.map(p => {
          const pid      = session.nodeID + '_p' + p.num
          const isActive = activePromptDetails.has(pid)
          return (
            <ChatTurnGroup
              key={p.num}
              p={p}
              isActive={isActive}
              onMouseEnter={() => onPromptHover(p.num)}
              onMouseLeave={onPromptLeave}
              onSelect={() => onPromptSelect(p.num)}
              onToolHover={ti => onToolHover(p.num, ti)}
              onToolLeave={onToolLeave}
              onToolClick={ti => onToolClick(p.num, ti)}
            />
          )
        })}
      </div>
    </div>
  )
}
