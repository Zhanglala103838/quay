import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 本地打包字体(离线)，必须在 index.css 之前注册 @font-face
import '@fontsource-variable/bricolage-grotesque/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import './index.css'
import App from './App.tsx'

// 平台标记:Windows 上窗口走原生装饰(无 macOS 交通灯),据此让标题栏左侧不再为交通灯留白。
// WebView2 的 UA 含 "Windows NT";mac WKWebView 含 "Macintosh"。
if (navigator.userAgent.includes('Windows')) {
  document.documentElement.classList.add('os-windows')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
