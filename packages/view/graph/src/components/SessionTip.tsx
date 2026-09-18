import React from 'react'

interface SessionTipProps {
  visible: boolean
}

export function SessionTip({ visible }: SessionTipProps) {
  return (
    <div id="session-tip" className={visible ? 'visible' : ''}>
      Click outside to reset
    </div>
  )
}
