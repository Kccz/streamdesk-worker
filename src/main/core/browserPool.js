/**
 * 全局浏览器池（单例）
 *
 * 核心优化：
 *   - 整个进程只启动一个 Chromium 实例，所有任务共享
 *   - 每个任务创建独立的 BrowserContext（Cookie/存储隔离）
 *   - 任务完成后关闭 context，不关 browser
 *   - 空闲超时自动关闭浏览器，下次使用时重新启动
 *   - 支持并发限制 + 排队等待
 *   - 浏览器崩溃自动恢复（唤醒排队任务）
 *   - context 超时自动回收（防泄漏）
 *
 * ⚠️ 注意：登录场景不要启用 blockMedia
 *
 * 性能对比：
 *   - 冷启动 chromium.launch()：3-5 秒 + 300MB
 *   - 复用 browser.newContext()：50-100ms + ~30MB/context
 *
 * 用法：
 *   const pool = require('./BrowserPool');
 *   const handle = await pool.acquire({ proxy: { server: 'socks5://...' } });
 *   try {
 *     const page = await handle.context.newPage();
 *     // ... 操作
 *   } finally {
 *     await pool.release(handle);
 *   }
 */
const { chromium } = require('playwright');
const logger = {
  info: (mod, msg) => console.log(`[${new Date().toLocaleTimeString()}] [${mod}] ${msg}`),
  warn: (mod, msg) => console.warn(`[${new Date().toLocaleTimeString()}] [${mod}] ⚠️  ${msg}`),
  error: (mod, msg) => console.error(`[${new Date().toLocaleTimeString()}] [${mod}] ❌ ${msg}`),
  success: (mod, msg) => console.log(`[${new Date().toLocaleTimeString()}] [${mod}] ✅ ${msg}`),
  debug: () => {},
};

// context 最大存活时间（防止调用方忘记 release 导致泄漏）
const CONTEXT_MAX_LIFETIME = parseInt(process.env.BROWSER_CONTEXT_TIMEOUT, 10) || 5 * 60 * 1000; // 5 分钟

class BrowserPool {
  constructor() {
    this.browser = null;
    this.activeContexts = 0;
    // worker 端默认 5 个并发 context（避免家用机带宽 / Chrome 内存爆）
    // 可通过 BROWSER_MAX_CONTEXTS 环境变量覆盖
    this.maxContexts = parseInt(process.env.BROWSER_MAX_CONTEXTS, 10) || 5;
    this.idleTimeout = parseInt(process.env.BROWSER_IDLE_TIMEOUT, 10) || 5 * 60 * 1000;
    this.idleTimer = null;
    this.launching = null;
    this.waitQueue = [];
    // 跟踪活跃 context 的超时回收定时器
    this.contextTimers = new Map();
  }

  /**
   * 获取浏览器实例（懒启动）
   */
  async getBrowser() {
    if (this.browser && this.browser.isConnected()) {
      this.clearIdleTimer();
      return this.browser;
    }

    // 防止并发启动
    if (this.launching) {
      return this.launching;
    }

    this.launching = this._launch();
    try {
      this.browser = await this.launching;
      return this.browser;
    } finally {
      this.launching = null;
    }
  }

  /**
   * 内部：启动浏览器
   */
  async _launch() {
    // worker 默认走有头模式（用真实 Chrome）
    // 显式设置 HEADLESS=true 才走无头
    const wantHeadless = process.env.HEADLESS === 'true';
    // 浏览器路径：环境变量 > 系统 chromium > macOS Chrome
    const fs = require('fs');
    const executablePath = process.env.BROWSER_EXECUTABLE_PATH
      || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : null)
      || (fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : null)
      || (fs.existsSync('/usr/bin/google-chrome-stable') ? '/usr/bin/google-chrome-stable' : null)
      || (fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null)
      || undefined;

    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--autoplay-policy=user-gesture-required',
      '--disable-infobars',
      '--no-first-run',
      '--window-size=1280,800',
    ];
    // 注意：worker 跑在 Mac mini 上的真实 Chrome / Chromium，不需要额外的 GL 启动参数
    // （--use-gl=angle / --use-angle=swiftshader / --enable-webgl / --ignore-gpu-blocklist 等）

    // 使用新版无头模式（不暴露 HeadlessChrome 标识，行为与有头一致）
    if (wantHeadless) {
      args.push('--headless=new');
    }

    logger.info('BrowserPool', `启动浏览器 (headless=${wantHeadless}, maxContexts=${this.maxContexts}${executablePath ? ', chrome=' + executablePath : ''})`);

    const browser = await chromium.launch({
      headless: wantHeadless,
      executablePath,
      args,
    });

    // 浏览器崩溃/断开时自动恢复
    browser.on('disconnected', () => {
      logger.warn('BrowserPool', '浏览器进程断开，清理状态');
      this.browser = null;
      this.activeContexts = 0;
      // 清理所有 context 超时定时器
      for (const timer of this.contextTimers.values()) {
        clearTimeout(timer);
      }
      this.contextTimers.clear();
      // 唤醒所有排队任务（让它们重新获取浏览器）
      while (this.waitQueue.length > 0) {
        const next = this.waitQueue.shift();
        next();
      }
    });

    logger.success('BrowserPool', '浏览器已启动');
    return browser;
  }

  /**
   * 获取一个隔离的浏览器上下文
   *
   * @param {Object} options
   * @param {Object|string} [options.proxy] - 代理 { server } 或 URL 字符串
   * @param {string} [options.userAgent] - 不传则用浏览器默认（推荐不传，避免 UA/TLS 指纹矛盾）
   * @param {Object} [options.viewport] - 不传则用浏览器默认
   * @param {boolean} [options.blockMedia=false] - ⚠️ Netflix 登录场景禁止使用（会触发 CDP Fetch.enable）
   * @param {boolean} [options.incognito=true] - 无痕模式
   * @returns {Promise<{ context, contextId }>}
   */
  async acquire(options = {}) {
    // 达到上限时排队等待
    if (this.activeContexts >= this.maxContexts) {
      logger.info('BrowserPool', `并发已满 ${this.activeContexts}/${this.maxContexts}，排队等待（队列: ${this.waitQueue.length}）`);
      await new Promise((resolve) => this.waitQueue.push(resolve));
    }

    const browser = await this.getBrowser();

    const {
      proxy = null,
      userAgent = undefined,
      viewport = null,
      blockMedia = false,
      incognito = true,
    } = options;

    const contextOptions = {};
    if (userAgent) contextOptions.userAgent = userAgent;
    if (viewport) contextOptions.viewport = viewport;

    if (proxy) {
      contextOptions.proxy = typeof proxy === 'string'
        ? { server: proxy }
        : proxy;
    }

    if (incognito) {
      contextOptions.storageState = undefined;
      contextOptions.acceptDownloads = false;
    }

    const context = await browser.newContext(contextOptions);
    this.activeContexts++;

    const contextId = `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    logger.info('BrowserPool', `acquire: ${contextId} (活跃 ${this.activeContexts}/${this.maxContexts}, 队列 ${this.waitQueue.length})`);

    // context 超时自动回收（防止调用方忘记 release）
    const autoReleaseTimer = setTimeout(async () => {
      logger.warn('BrowserPool', `context ${contextId} 超时 ${CONTEXT_MAX_LIFETIME / 1000}s 未释放，自动回收`);
      await this.release({ context, contextId });
    }, CONTEXT_MAX_LIFETIME);
    this.contextTimers.set(contextId, autoReleaseTimer);

    // ⚠️ blockMedia 会触发 CDP Fetch.enable，Netflix 登录场景禁止使用
    if (blockMedia) {
      await context.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
          route.abort();
        } else {
          route.continue();
        }
      });
    }

    return { context, contextId };
  }

  /**
   * 释放上下文
   */
  async release(handle) {
    if (!handle?.context) return;

    // 清除超时回收定时器
    if (handle.contextId && this.contextTimers.has(handle.contextId)) {
      clearTimeout(this.contextTimers.get(handle.contextId));
      this.contextTimers.delete(handle.contextId);
    }

    try {
      await handle.context.close();
    } catch {
      // context 可能已经关了
    }
    this.activeContexts = Math.max(0, this.activeContexts - 1);
    logger.info('BrowserPool', `release: ${handle.contextId} (活跃 ${this.activeContexts}/${this.maxContexts}, 队列 ${this.waitQueue.length})`);

    // 唤醒排队中的下一个任务
    if (this.waitQueue.length > 0 && this.activeContexts < this.maxContexts) {
      const next = this.waitQueue.shift();
      next();
    }

    // 没有活跃 context 且没有排队，启动空闲计时器
    if (this.activeContexts === 0 && this.waitQueue.length === 0) {
      this.startIdleTimer();
    }
  }

  /**
   * 空闲计时器：一段时间没有任务就关闭浏览器释放内存
   */
  startIdleTimer() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(async () => {
      if (this.activeContexts === 0 && this.browser) {
        logger.info('BrowserPool', `空闲 ${this.idleTimeout / 1000}s，关闭浏览器释放内存`);
        await this.shutdown();
      }
    }, this.idleTimeout);
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * 关闭浏览器（优雅退出时调用）
   */
  async shutdown() {
    this.clearIdleTimer();
    // 清理所有 context 超时定时器
    for (const timer of this.contextTimers.values()) {
      clearTimeout(timer);
    }
    this.contextTimers.clear();

    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
      this.activeContexts = 0;
      logger.info('BrowserPool', '浏览器已关闭');
    }
  }

  /**
   * 状态信息
   */
  getStatus() {
    return {
      running: this.browser?.isConnected() ?? false,
      activeContexts: this.activeContexts,
      maxContexts: this.maxContexts,
      queueLength: this.waitQueue.length,
    };
  }
}

// 单例导出
module.exports = new BrowserPool();
