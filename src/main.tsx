import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 本地打包字体(离线)，必须在 index.css 之前注册 @font-face
import '@fontsource-variable/bricolage-grotesque/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
