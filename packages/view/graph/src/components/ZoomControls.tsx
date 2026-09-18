import React from 'react'

interface ZoomControlsProps {
  percent: number
  onZoom: (factor: number) => void
}

export function ZoomControls({ percent, onZoom }: ZoomControlsProps) {
  return (
    <div id="zoom-controls">
      <button className="zoom-btn" onClick={() => onZoom(1 / 1.3)}>-</button>
      <span id="zoom-pct">{percent}%</span>
      <button className="zoom-btn" onClick={() => onZoom(1.3)}>+</button>
    </div>
  )
}
