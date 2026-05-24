/**
 * Worker Long-Polling 客户端
 * 抽自 ~/Desktop/streamdesk-worker/worker.js 的 runPoll()
 * 加 start/stop 控制 + EventEmitter 状态推送
 */
import axios, { AxiosInstance } from 'axios'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { logger } from '../logger'
import { historyStore, statsStore } from './settings'
import type { CurrentTask, TaskHistoryItem, RuntimeStats, WorkerStatus } from '@shared/types'

// CommonJS 模块（直接复用 worker.js 里的 loginService / manualOperate）
// 编译后位于 out/main/core/，由 copy-cjs 插件处理
// eslint-disable-next-line @typescript-eslint/no-var-requires
const LoginService = require('./core/loginService.js')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runManualOperate } = require('./core/manualOperate.js')

interface StartOptions {
  server: string
  token: string
  workerId: string
  appVersion: string
}

interface PollTask {
  id: string
  type?: 'netflix_login' | 'manual_operate'
  email: string
  password?: string
  cookies?: any
  proxy?: string | null
}

export class PollClient extends EventEmitter {
  private stopFlag = true
  private status: WorkerStatus = 'stopped'
  private current: CurrentTask | null = null
  private currentService: any = null
  /** 用于中止挂起的 long-poll GET */
  private pollAbortCtrl: AbortController | null = null
  /** 401 等终态错误：通知 UI 重新激活 */
  private fatalAuthError = false

  isRunning(): boolean {
    return !this.stopFlag
  }

  getStats(): RuntimeStats {
    const s = statsStore.get()
    return {
      status: this.status,
      current: this.current,
      todayTotal: s.total,
      todaySuccess: s.success,
      todayFailed: s.failed,
    }
  }

  getHistory(): TaskHistoryItem[] {
    return historyStore.list()
  }

  async start(opts: StartOptions): Promise<void> {
    if (!this.stopFlag) {
      logger.warn('Worker', 'PollClient 已在运行，忽略重复 start')
      return
    }

    this.stopFlag = false
    this.setStatus('polling')
    logger.info('Worker', `启动 server=${opts.server} workerId=${opts.workerId}`)

    const httpAgent = new http.Agent({ keepAlive: false })
    const httpsAgent = new https.Agent({ keepAlive: false })
    const client: AxiosInstance = axios.create({
      baseURL: opts.server,
      timeout: 30000,
      httpAgent,
      httpsAgent,
      headers: {
        'X-Worker-Token': opts.token,
        'X-Worker-Id': opts.workerId,
        'X-Worker-OS': process.platform,
        'X-Worker-OS-Version': os.release(),
        'X-Worker-Node-Version': process.version,
        'X-Worker-App-Version': opts.appVersion,
        Connection: 'close',
      },
    })

    while (!this.stopFlag) {
      try {
        this.pollAbortCtrl = new AbortController()
        const { data } = await client.get('/api/worker/login/poll', {
          signal: this.pollAbortCtrl.signal,
        })
        this.pollAbortCtrl = null
        const task: PollTask | null = data?.data?.task || null

        if (!task) continue

        await this.handleTask(client, task)
      } catch (e: any) {
        this.pollAbortCtrl = null
        // 主动取消（stop 调用），直接退出循环
        if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError' || axios.isCancel?.(e)) {
          logger.debug('Worker', 'Poll 已主动中止')
          break
        }

        const status = e?.response?.status
        // token 失效：终态错误，停止 worker，通知 UI
        if (status === 401 || status === 403) {
          logger.error('Worker', `Token 已失效（HTTP ${status}），需要重新激活`)
          this.fatalAuthError = true
          this.emit('auth:invalid', { status, message: e?.response?.data?.message })
          this.stopFlag = true
          break
        }

        const code = status || e.code || 'UNKNOWN'
        const isNetGlitch =
          code === 'ECONNRESET' ||
          code === 'ETIMEDOUT' ||
          code === 'ECONNABORTED' ||
          code === 'EPIPE' ||
          /socket hang up/i.test(e.message || '')
        if (isNetGlitch) {
          logger.debug('Worker', `Poll 闪断: ${code}，立即重试`)
          await sleep(500)
        } else {
          logger.error('Worker', `Poll 错误: ${code} - ${e.message}`)
          this.setStatus('error')
          await sleep(5000)
          if (!this.stopFlag) this.setStatus('polling')
        }
      }
    }

    logger.info('Worker', 'PollClient 已停止')
    this.setStatus('stopped')
  }

  stop(): void {
    if (this.stopFlag) return
    logger.info('Worker', '请求停止 PollClient')
    this.stopFlag = true
    // 1. 立即取消挂起的 long-poll GET
    if (this.pollAbortCtrl) {
      try { this.pollAbortCtrl.abort() } catch { /* ignore */ }
      this.pollAbortCtrl = null
    }
    // 2. 中止正在执行的登录任务
    if (this.currentService?.abort) {
      this.currentService.abort().catch(() => {})
    }
    // 立即推送状态，让 UI 显示"停止中"
    this.setStatus('stopping')
  }

  /** 中止当前正在执行的任务（worker 仍继续 poll 下一个） */
  abortCurrent(): void {
    if (!this.current) return
    logger.warn('Worker', `用户请求中止任务 ${this.current.id}`)
    if (this.currentService?.abort) {
      this.currentService.abort().catch(() => {})
    }
    // manual_operate 类型没有 currentService.abort，靠云端取消信号或浏览器关闭
  }

  private async handleTask(client: AxiosInstance, task: PollTask): Promise<void> {
    const taskType = task.type || 'netflix_login'
    this.current = { id: task.id, type: taskType, email: task.email, startedAt: Date.now() }
    this.setStatus('running')
    logger.info('Worker', `收到任务 ${task.id}: ${task.email} (${taskType})`)

    const t0 = Date.now()
    let result: { success: boolean; cookies?: any; error?: string; cancelled?: boolean }
    try {
      if (taskType === 'manual_operate') {
        result = await runManualOperate(task, client)
      } else {
        const service = new LoginService({ proxy: task.proxy || null })
        this.currentService = service
        result = await service.login(task.email, task.password)
      }
    } catch (e: any) {
      result = { success: false, cookies: null, error: e.message }
    } finally {
      this.currentService = null
    }
    const ms = Date.now() - t0

    if (result.cancelled) {
      logger.warn('Worker', `任务 ${task.id} 已被云端取消（${(ms / 1000).toFixed(1)}s）`)
    } else {
      try {
        await client.post('/api/worker/login/complete', {
          taskId: task.id,
          success: result.success,
          cookies: result.cookies,
          error: result.error,
          duration: ms,
        })
        if (result.success) {
          logger.info('Worker', `任务 ${task.id} ✅ 成功 (${(ms / 1000).toFixed(1)}s)`)
        } else {
          logger.warn('Worker', `任务 ${task.id} ❌ 失败: ${result.error} (${(ms / 1000).toFixed(1)}s)`)
        }
        // 持久化统计 + 历史
        statsStore.bump(!!result.success)
        const history: TaskHistoryItem = {
          id: task.id,
          type: taskType,
          email: task.email,
          success: !!result.success,
          error: result.error,
          duration: ms,
          finishedAt: Date.now(),
        }
        historyStore.push(history)
        this.emit('task:history', history)
      } catch (e: any) {
        logger.error('Worker', `上报结果失败: ${e.message}`)
      }
    }

    this.current = null
    if (!this.stopFlag) this.setStatus('polling')
  }

  private setStatus(s: WorkerStatus): void {
    this.status = s
    this.emit('stats', this.getStats())
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const pollClient = new PollClient()
