import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './index.css'

declare global {
  interface Window { __GRAPH_DATA__: import('./types').GraphData }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <App data={window.__GRAPH_DATA__} />,
)
