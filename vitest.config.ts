import { defineConfig } from 'vitest/config'

// 仅覆盖纯逻辑(分页数学),node 环境即可,无需 jsdom。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
