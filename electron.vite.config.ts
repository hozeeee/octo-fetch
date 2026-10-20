import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: { build: { rollupOptions: { input: { 'index': 'src/main/index.ts', 'script-worker': 'src/main/scripts/worker.ts', 'injection-worker': 'src/main/scripts/injection-worker.ts', 'sandbox-process': 'src/main/scripts/sandbox-process.ts', 'capture-process': 'src/main/capture/capture-process.ts' } } } },
  preload: {},
  renderer: { plugins: [react()] }
})
