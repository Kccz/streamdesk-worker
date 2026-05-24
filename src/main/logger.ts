/**
 * 简易日志：控制台 + 内存环（最近 500 条） + 文件
 * 启动 worker 后会通过 IPC 推送给渲染进程
 */
import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync, appendFileSync, existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { LogLine } from '@shared/types'

const MAX_BUFFER = 500
const buffer: LogLine[] = []
const bus = new EventEmitter()
bus.setMaxListeners(0)

let logFile: string | null = null
function ensureLogFile(): string {
  if (logFile) return logFile
  const dir = join(app.getPath('logs'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  logFile = join(dir, `worker-${new Date().toISOString().slice(0, 10)}.log`)
  return logFile
}

function emit(level: LogLine['level'], mod: string, msg: string): void {
  const line: LogLine = { level, ts: Date.now(), text: `[${mod}] ${msg}` }
  buffer.push(line)
  if (buffer.length > MAX_BUFFER) buffer.shift()

  // 控制台输出
  const ts = new Date(line.ts).toLocaleTimeString()
  const tag = level === 'error' ? '❌' : level === 'warn' ? '⚠️ ' : level === 'debug' ? '🔍' : '·'
  // eslint-disable-next-line no-console
  console.log(`${ts} ${tag} ${line.text}`)

  // 文件
  try {
    appendFileSync(ensureLogFile(), `${new Date(line.ts).toISOString()} [${level}] ${line.text}\n`)
  } catch {
    /* ignore */
  }

  bus.emit('line', line)
}

export const logger = {
  info: (mod: string, msg: string) => emit('info', mod, msg),
  warn: (mod: string, msg: string) => emit('warn', mod, msg),
  error: (mod: string, msg: string) => emit('error', mod, msg),
  debug: (mod: string, msg: string) => emit('debug', mod, msg),
  buffer: () => buffer.slice(),
  on: (cb: (line: LogLine) => void) => {
    bus.on('line', cb)
    return () => bus.off('line', cb)
  },
  logDir: () => {
    ensureLogFile()
    return app.getPath('logs')
  },
}
