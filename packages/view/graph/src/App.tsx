import React, { useRef, useState, useEffect } from 'react'
import type { GraphData } from './types'
import { useGraphInteractions } from './hooks/useGraphInteractions'
import { Header }       from './components/Header'
import { Sidebar }      from './components/Sidebar'
import { ZoomControls } from './components/ZoomControls'
import { PromptTip }    from './components/PromptTip'
import { SessionTip }   from './components/SessionTip'

interface AppProps {
  data: GraphData
}

export function App({ data }: AppProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isDark, setIsDark] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light'
  }, [isDark])

  const {
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
  } = useGraphInteractions(containerRef, data, isDark)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Header
        title={data.title}
        directory={data.directory}
        catGif={data.catGifBase64}
        focusSessionId={data.focusSessionId}
        isDark={isDark}
        onToggleTheme={() => setIsDark(d => !d)}
      />
      <div id="app">
        <div ref={containerRef} id="cy" />
      </div>
      <Sidebar
        open={sidebarOpen}
        daySessionCount={sidebarDayCount}
        session={sidebarSession}
        scrollTarget={scrollTarget}
        activePromptDetails={activePromptDetails}
        onClose={closeSidebar}
        onPromptHover={onSidebarPromptHover}
        onPromptLeave={onSidebarPromptLeave}
        onPromptSelect={onSidebarPromptSelect}
        onToolHover={onToolHover}
        onToolLeave={onToolLeave}
        onToolClick={onToolClick}
      />
      <ZoomControls percent={zoomPercent} onZoom={zoomStep} />
      <SessionTip visible={sessionTipVisible} />
      {promptTip && <PromptTip text={promptTip.text} x={promptTip.x} y={promptTip.y} />}
    </div>
  )
}
