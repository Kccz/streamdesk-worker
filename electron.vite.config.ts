import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'

/** 把主进程的 .cjs 文件原样拷到 out/main/core，方便 require('./core/xxx.cjs') */
function copyCjsPlugin() {
  return {
    name: 'copy-cjs-files',
    closeBundle() {
      const src = resolve(__dirname, 'src/main/core')
      const dst = resolve(__dirname, 'out/main/core')
      if (!existsSync(dst)) mkdirSync(dst, { recursive: true })
      ;['browserPool.js', 'loginService.js', 'manualOperate.js'].forEach((f) => {
        const sf = resolve(src, f)
        if (existsSync(sf)) copyFileSync(sf, resolve(dst, f))
      })
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyCjsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [vue()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
})
