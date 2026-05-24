/**
 * 手动操作任务：worker 端启动一个独立的 chromium 实例（不走 BrowserPool 复用），
 * 注入 cookie 打开 Netflix。用户在 worker 屏幕前手动操作。
 *
 * 关闭检测（任一触发即视为完成）：
 *   1. page.close       - ⌘W 关 tab
 *   2. context.close    - 关 window
 *   3. browser.disconnected - ⌘Q 整个 Chrome 进程被杀
 *   4. 云端取消         - alive long polling 收到 alive=false 立即关闭
 *   5. 30 分钟超时
 *
 * 之所以不走 pool：复用 pool 时用户 ⌘Q 整个 Chrome 会牵连 pool 里所有
 * 在跑的批量登录任务。手动操作本来就是低频单条操作，多 1-2s 启动开销可接受。
 */
const fs = require('fs');
const { chromium } = require('playwright');

const logger = {
  info: (mod, msg) => console.log(`[${new Date().toLocaleTimeString()}] [${mod}] ${msg}`),
  warn: (mod, msg) => console.warn(`[${new Date().toLocaleTimeString()}] [${mod}] ⚠️  ${msg}`),
  error: (mod, msg) => console.error(`[${new Date().toLocaleTimeString()}] [${mod}] ❌ ${msg}`),
  success: (mod, msg) => console.log(`[${new Date().toLocaleTimeString()}] [${mod}] ✅ ${msg}`),
};

const MAX_LIFETIME_MS = 30 * 60 * 1000; // 最多 30 分钟

/**
 * 探测可用的 Chrome / Chromium 路径
 */
function resolveExecutablePath() {
  return process.env.BROWSER_EXECUTABLE_PATH
    || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : null)
    || (fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : null)
    || (fs.existsSync('/usr/bin/google-chrome-stable') ? '/usr/bin/google-chrome-stable' : null)
    || (fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : null)
    || undefined;
}

/**
 * @param {Object} task { id, email, cookies, proxy }
 * @param {Object} client - axios 实例（带 X-Worker-Token 鉴权），用于 alive long polling
 * @returns {Promise<{ success, cookies, error, cancelled? }>}
 */
async function runManualOperate(task, client) {
  const { id: taskId, email, cookies, proxy } = task;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return { success: false, error: '未提供 cookies', cookies: null };
  }

  logger.info('ManualOp', `开始: ${email} (${cookies.length} 个 cookies)`);

  let browser = null;
  let context = null;
  let page = null;
  let updatedCookies = cookies;
  let cancelled = false;
  let aliveWatcherStop = false;

  try {
    // 独立 launch
    const executablePath = resolveExecutablePath();
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--no-first-run',
      '--window-size=1280,800',
    ];
    logger.info('ManualOp', `启动独立浏览器${executablePath ? ' (' + executablePath + ')' : ''}`);
    browser = await chromium.launch({
      headless: false,
      executablePath,
      args,
    });

    const contextOptions = {};
    if (proxy) contextOptions.proxy = { server: proxy };
    context = await browser.newContext(contextOptions);

    await context.addCookies(cookies);
    logger.info('ManualOp', `已注入 ${cookies.length} 个 cookies`);

    page = await context.newPage();
    await page.goto('https://www.netflix.com/browse', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    }).catch((e) => {
      logger.warn('ManualOp', `跳转失败但继续: ${e.message}`);
    });

    logger.success('ManualOp', '浏览器已打开，请手动操作。关闭页面 / 窗口 / 退出 Chrome 即可完成任务。');

    // 等任一关闭事件触发，或云端取消，或 30 分钟超时
    await new Promise((resolve) => {
      let resolved = false;
      const done = (reason) => {
        if (resolved) return;
        resolved = true;
        aliveWatcherStop = true;
        logger.info('ManualOp', `检测到关闭: ${reason}`);
        resolve();
      };

      page.once('close', () => done('page closed'));
      context.once('close', () => done('context closed'));
      browser.once('disconnected', () => done('browser disconnected'));
      setTimeout(() => done(`超时 ${MAX_LIFETIME_MS / 60000} 分钟`), MAX_LIFETIME_MS);

      // 云端 alive long polling 循环：每次请求挂起最多 30s
      // 取消时云端立即返回 alive=false → worker 立即关浏览器
      if (client && taskId) {
        (async () => {
          while (!aliveWatcherStop) {
            try {
              const { data } = await client.get(
                `/api/worker/task/${taskId}/alive?wait=true`,
                { timeout: 40_000 },
              );
              if (aliveWatcherStop) return;
              const alive = data?.data?.alive;
              if (alive === false) {
                cancelled = true;
                logger.warn('ManualOp', '云端任务已取消，主动关闭浏览器');
                try { await browser.close(); } catch {}
                done('cancelled by server');
                return;
              }
              // alive === true 立即下一轮
            } catch (e) {
              if (aliveWatcherStop) return;
              // 网络抖动 → 短暂 sleep 再重试
              await new Promise(r => setTimeout(r, 2000));
            }
          }
        })();
      }
    });

    // 在 context / browser 关闭前抓最新 cookies
    try {
      updatedCookies = await context.cookies('https://www.netflix.com');
      logger.success('ManualOp', `读取最新 ${updatedCookies.length} 个 cookies`);
    } catch (e) {
      logger.warn('ManualOp', `读取最新 cookies 失败（连接已断），回退用入参 cookies: ${e.message}`);
    }

    return { success: true, cookies: updatedCookies, error: null, cancelled };
  } catch (err) {
    logger.error('ManualOp', `异常: ${err.message}`);
    return { success: false, cookies: null, error: err.message };
  } finally {
    aliveWatcherStop = true;
    if (browser && browser.isConnected()) {
      try { await browser.close(); } catch {}
    }
  }
}

module.exports = { runManualOperate };
