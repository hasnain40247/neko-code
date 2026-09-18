import React from 'react'

interface PromptTipProps {
  text: string
  x: number
  y: number
}

export function PromptTip({ text, x, y }: PromptTipProps) {
  return (
    <div
      id="prompt-tip"
      style={{ display: 'block', left: x + 'px', top: y + 'px' }}
    >
      {text}
    </div>
  )
}
