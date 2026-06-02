import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 固定端口 + strictPort:与 tauri.conf devUrl 死锁一致。端口被占时 vite 直接报错退出,
  // 而不是静默跳到 5174 导致 Tauri 窗口加载到另一个占着 5173 的项目(曾踩此坑)。
  server: { port: 1420, strictPort: true },
})
