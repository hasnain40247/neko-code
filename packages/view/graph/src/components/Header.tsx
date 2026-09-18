import React from 'react'

interface HeaderProps {
  title: string
  directory: string
  catGif: string | null
  focusSessionId: string | null
}

export function Header({ title, directory, catGif, focusSessionId }: HeaderProps) {
  return (
    <>
      <div id="hdr">
        {catGif && <img id="hdr-gif" src={catGif} alt="" />}
        <span id="hdr-brand">neko</span>
      </div>
      <div id="hdr-fade" />
      <div id="meta-pill">
        <span id="meta-pill-title">{title}</span>
        {focusSessionId && (
          <span id="meta-pill-id">{focusSessionId.slice(0, 12)}</span>
        )}
      </div>
      <div id="dir-label">
        <span id="dir-label-prompt">$</span>
        <span>{directory}</span>
        <span id="dir-label-arrow">›</span>
      </div>
    </>
  )
}
