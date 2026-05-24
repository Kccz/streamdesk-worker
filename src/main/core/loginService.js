/**
 * 登录服务
 */

const logger = {
  info: (mod, msg) => console.log(`[${new Date().toLocaleTimeString()}] [${mod}] ${msg}`),
  warn: (mod, msg) => console.warn(`[${new Date().toLocaleTimeString()}] [${mod}] ⚠️  ${msg}`),
  error: (mod, msg) => console.error(`[${new Date().toLocaleTimeString()}] [${mod}] ❌ ${msg}`),
  success: (mod, msg) => console.log(`[${new Date().toLocaleTimeString()}] [${mod}] ✅ ${msg}`),
  debug: (mod, msg) => console.log(`[${new Date().toLocaleTimeString()}] [${mod}] ${msg}`),
};

const GRAPHQL_URL = 'https://web.prod.cloud.netflix.com/graphql';
const PERSISTED_QUERY_CLCS = { id: '40d48207-9275-4fc4-b7da-352c2d1e5756', version: 102 };
const RECAPTCHA_SITE_KEY = '6Lf8hrcUAAAAAIpQAFW2VFjtiYnThOjZOA5xvLyR';

// 目标 locale
// 'zh-SG'  简体中文
// 'zh-HK'  繁体中文
// 'en-US'  英文
const TARGET_LOCALE = process.env.NETFLIX_LOCALE || 'zh-SG';

// 终态视图：服务返回这些 view 说明账号本身有问题
const FATAL_LOGGING_VIEWS = {
  authenticationLinkSent: '此账号无会员，请检查！',
  planSelectionContext: '此账号无会员，请检查！',
};

class LoginService {
  constructor(options = {}) {
    this.proxy = options.proxy || null;
    // 临时默认有头模式（便于观察登录过程）
    // 显式 options.headless 优先；其次 HEADLESS 环境变量（HEADLESS=true 强制无头）；默认有头
    this.headless = options.headless !== undefined ? options.headless : process.env.HEADLESS === 'true';
    this.timeout = options.timeout || 30000;
    this._currentContext = null;  // 当前 context，供外部 abort 使用
    this._aborted = false;
  }

  /**
   * 主动中止登录任务（由外部如 worker 取消时调用）
   * 关掉 context → 所有 page 操作立刻抛错 → LoginService 走 finally 释放资源
   */
  async abort() {
    if (this._aborted) return;
    this._aborted = true;
    if (this._currentContext) {
      try { await this._currentContext.close(); } catch {}
    }
  }

  async login(email, password, options = {}) {
    if (typeof options === 'function') options = {};
    const { dataPath } = options;
    const t0 = Date.now();
    const elapsed = () => `${Date.now() - t0}ms`;

    // 密码 mask（仅用于调试，不暴露明文）
    const maskedPwd = password
      ? `${password.slice(0, 1)}***${password.slice(-1)}(len=${password.length})`
      : 'EMPTY';
    logger.info('NetflixLogin', `[0] 登录开始: ${email} 密码=${maskedPwd}`);

    let context = null;
    let page = null;
    let poolHandle = null;

    try {
      // ========== 1. 从 BrowserPool 获取浏览器（复用主进程，每次新建 context）==========
      logger.info('NetflixLogin', `[1] 获取浏览器 proxy=${this.proxy || 'none'}`);

      const browserPool = require('./browserPool');
      poolHandle = await browserPool.acquire({
        proxy: this.proxy ? { server: this.proxy } : null,
        incognito: true,
      });
      context = poolHandle.context;
      this._currentContext = context;

      logger.info('NetflixLogin', `[2] 浏览器已就绪（pool 复用, ${elapsed()})`);

      page = await context.newPage();

      // 监听页面跳转，记录当前 URL（便于排查停留在哪一步）
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
          logger.info('NetflixLogin', `[页面] → ${frame.url()}`);
        }
      });

      // ========== 2. 资源不做拦截，保持完整加载 ==========

      // ========== 3. 被动监听 GraphQL 响应 ==========
      let emailIntercepted = false;
      let emailRespData = null;
      let loginError = null;
      let resolveEmailDone;
      const emailDonePromise = new Promise((resolve) => {
        resolveEmailDone = resolve;
      });

      logger.info('NetflixLogin', '[3] 设置 GraphQL 响应被动监听...');
      page.on('response', async (response) => {
        try {
          if (emailIntercepted) return;
          const url = response.url();
          if (!url.includes('graphql')) return;
          if (response.request().method() !== 'POST') return;

          const postData = response.request().postData() || '';
          if (!postData.includes('CLCSScreenUpdate') || !postData.includes('userLoginId')) return;

          const respText = await response.text().catch(() => '');
          if (!respText) return;

          logger.info('NetflixLogin', `[监听] GraphQL 响应 status=${response.status()} length=${respText.length}`);

          try {
            const respData = JSON.parse(respText);
            const result = respData?.data?.result;
            const errors = respData?.errors;
            if (errors?.length) {
              loginError = errors[0].message;
              logger.warn('NetflixLogin', `[监听] GraphQL 错误: ${loginError}`);
            } else if (result) {
              const nodes = result.screen?.componentTree?.nodes || [];
              const errorNode = this._findNode(nodes, 'alert-message-body');
              const errorText = errorNode?.webTextWithTags?.text?.value || errorNode?.plainContent?.value;
              if (errorText) {
                loginError = errorText;
                logger.warn('NetflixLogin', `[监听] 页面错误提示: ${errorText}`);
              }
              emailRespData = result;
            }
          } catch (parseErr) {
            const status = response.status();
            if (status === 403) {
              loginError = `Netflix 拒绝访问（IP 受限）。请在「代理配置」中为 Netflix 登录指定可用代理`;
            } else if (status >= 400) {
              loginError = `Netflix 返回 ${status}`;
            }
          }

          emailIntercepted = true;
          resolveEmailDone();
        } catch {}
      });

      // ========== 4. 打开登录页 ==========
      logger.info('NetflixLogin', '[4] 打开 Netflix 登录页...');
      await page.goto('https://www.netflix.com/login', { waitUntil: 'domcontentloaded', timeout: this.timeout });
      logger.info('NetflixLogin', `[5] 登录页加载完成 url=${page.url()} (${elapsed()})`);

      // ========== 5. 等页面 load + 邮箱输入框可见 ==========
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      await page.locator('[data-uia="field-userLoginId"], input[name="userLoginId"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15000 });

      logger.info('NetflixLogin', `[7] 页面加载完成 (${elapsed()})`);

      // ========== 6. 提交邮箱（UI 操作）==========
      logger.info('NetflixLogin', '[8] 输入邮箱 + 点击 Continue...');
      await page.waitForTimeout(1500 + Math.random() * 1000);
      const emailInputEl = page.locator('[data-uia="field-userLoginId"], input[name="userLoginId"]').first();
      await emailInputEl.click();
      await page.waitForTimeout(300);
      await emailInputEl.fill(email);
      await page.waitForTimeout(800 + Math.random() * 500);
      await page.locator('[data-uia="continue-button"], button[type="submit"]').first().click();
      logger.info('NetflixLogin', '[9] 已点击 Continue，等待响应...');

      // ========== 7. 等待邮箱阶段响应（Promise + 超时）==========
      const waitResult = await Promise.race([
        emailDonePromise.then(() => 'ok'),
        new Promise((r) => setTimeout(() => r('timeout'), 15000)),
      ]);
      if (waitResult === 'timeout') {
        logger.error('NetflixLogin', '[10] 邮箱阶段响应超时（15s 内未收到响应）');
        return { success: false, cookies: null, error: '邮箱阶段响应超时，页面未发起预期请求' };
      }
      logger.info('NetflixLogin', `[10] 邮箱阶段完成 (${elapsed()})`);

      if (loginError) {
        logger.warn('NetflixLogin', `[11] 检测到错误，终止: ${loginError}`);
        return { success: false, cookies: null, error: loginError };
      }

      // ========== 8. 解析响应 ==========
      const emailScreenView = emailRespData?.screen?.loggingViewName || '';
      const trackingInfo = emailRespData?.screen?.trackingInfo || '';
      const trackingScreenName = typeof trackingInfo === 'string'
        ? (() => { try { return JSON.parse(trackingInfo)?.screenName || ''; } catch { return ''; } })()
        : (trackingInfo?.screenName || '');
      const emailOutcome = emailRespData?.outcomeType;
      const isDirectSuccess = emailOutcome === 'CLCSScreenUpdateEffect' || !!emailRespData?.effect;
      logger.info('NetflixLogin', `[11] 页面信息: loggingView=${emailScreenView}, trackingScreen=${trackingScreenName}, outcome=${emailOutcome}, directSuccess=${isDirectSuccess}`);

      // ========== 9. 终态分支 D ==========
      const fatalMsg = FATAL_LOGGING_VIEWS[emailScreenView];
      if (fatalMsg) {
        logger.warn('NetflixLogin', `[12] 终态 loggingView=${emailScreenView}: ${email}`);
        return { success: false, cookies: null, error: fatalMsg };
      }

      // ========== 10. 分支 A / B / C ==========
      if (isDirectSuccess) {
        logger.info('NetflixLogin', '[12] 分支 A: 一次提交直接成功');
      } else {
        const isOtpPage = emailScreenView === 'collectOtp' || emailScreenView.includes('otp');
        logger.info('NetflixLogin', `[12] 分支 ${isOtpPage ? 'C (OTP 页 → 跳密码页)' : 'B (密码页)'}: 开始浏览器内 GraphQL 流程...`);

        const evalResult = await page.evaluate(
          async ({ email, password, emailRespData, isOtpPage, GRAPHQL_URL, PERSISTED_QUERY_CLCS, RECAPTCHA_SITE_KEY, TARGET_LOCALE }) => {
            const browserLogs = [];
            const log = (msg) => browserLogs.push(msg);

            // 调试：确认 password 完整传入 evaluate（不打印明文，只看长度+首尾字符）
            log(`[browser] 收到 password mask=${password ? password[0] + '***' + password[password.length - 1] : 'EMPTY'} (len=${password?.length || 0})`);

            // 动态读取页面当前的 Netflix app-version（避免硬编码过期）
            const APP_VERSION = (() => {
              try {
                if (window.netflix?.reactContext?.models?.serverDefs?.data?.BUILD_IDENTIFIER) {
                  return window.netflix.reactContext.models.serverDefs.data.BUILD_IDENTIFIER;
                }
                const m = document.documentElement.outerHTML.match(/"BUILD_IDENTIFIER"\s*:\s*"([^"]+)"/);
                if (m) return m[1];
              } catch {}
              return 'vf45abb7a';
            })();
            log(`[browser] 检测到 app-version=${APP_VERSION}`);

            // 动态读取页面 locale（保持和页面一致，避免 zh-sg/zh-hk 混用）
            const PAGE_LOCALE = (() => {
              try {
                const m = location.pathname.match(/^\/([a-z]{2}-[a-z]{2})\//);
                if (m) return m[1];
              } catch {}
              return TARGET_LOCALE.toLowerCase();
            })();
            log(`[browser] 检测到 page locale=${PAGE_LOCALE}`);

            async function gql(variables) {
              const res = await fetch(GRAPHQL_URL, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'x-netflix.context.operation-name': 'CLCSScreenUpdate',
                  'x-netflix.context.ui-flavor': 'akira',
                  'x-netflix.context.locales': PAGE_LOCALE,
                  'x-netflix.request.attempt': '1',
                  'x-netflix.request.client.context': JSON.stringify({ appstate: 'foreground' }),
                  'x-netflix.request.clcs.bucket': 'high',
                  'x-netflix.request.id': Math.random().toString(16).slice(2).padEnd(32, '0'),
                  'x-netflix.request.toplevel.uuid': crypto.randomUUID(),
                  'x-netflix.request.originating.url': location.href,
                  'x-netflix.context.app-version': APP_VERSION,
                  referer: 'https://www.netflix.com/',
                },
                credentials: 'include',
                body: JSON.stringify({
                  operationName: 'CLCSScreenUpdate',
                  variables: { format: 'HTML', imageFormat: 'PNG', locale: PAGE_LOCALE, ...variables },
                  extensions: { persistedQuery: PERSISTED_QUERY_CLCS },
                }),
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.json();
            }

            function findNode(nodes, testId) {
              if (!Array.isArray(nodes)) return null;
              for (const node of nodes) {
                if (!node || typeof node !== 'object') continue;
                if (node.testId === testId) return node;
                for (const key of Object.keys(node)) {
                  const val = node[key];
                  if (Array.isArray(val)) { const f = findNode(val, testId); if (f) return f; }
                  else if (val && typeof val === 'object') { const f = findNode([val], testId); if (f) return f; }
                }
              }
              return null;
            }

            function extractSU(onPress) {
              if (!onPress) return null;
              if (onPress.serverScreenUpdate) return onPress.serverScreenUpdate;
              for (const arr of [onPress.nodes, onPress.effects]) {
                if (Array.isArray(arr)) { for (const n of arr) { const su = extractSU(n); if (su) return su; } }
              }
              return null;
            }

            try {
              let passwordPageData = emailRespData;
              let serverState = emailRespData?.screen?.serverState;

              // OTP 页面 → 跳密码页
              if (isOtpPage) {
                log('[browser] 检测到 OTP 页面，查找 usePasswordInsteadHelpMenuItem...');
                const nodes = emailRespData?.screen?.componentTree?.nodes || [];
                const usePasswordNode = findNode(nodes, 'usePasswordInsteadHelpMenuItem');
                const usePasswordSU = extractSU(usePasswordNode?.onPress);
                if (!usePasswordSU) return { error: '未找到 Use password instead', browserLogs };
                log('[browser] 提交 usePasswordInstead 跳转...');

                const jumpResp = await gql({ serverState, serverScreenUpdate: usePasswordSU, inputFields: [] });
                if (jumpResp?.errors?.length) return { error: jumpResp.errors[0].message, browserLogs };
                passwordPageData = jumpResp?.data?.result;
                serverState = passwordPageData?.screen?.serverState;
                log(`[browser] 跳转完成 → ${passwordPageData?.screen?.loggingViewName || 'unknown'}`);

                const jumpNodes = passwordPageData?.screen?.componentTree?.nodes || [];
                const jumpErrNode = findNode(jumpNodes, 'alert-message-body');
                const jumpErrText = jumpErrNode?.webTextWithTags?.text?.value || jumpErrNode?.plainContent?.value;
                if (jumpErrText) return { error: jumpErrText, browserLogs };
              }

              log('[browser] 查找 sign-in-button / continue-button...');
              const pwNodes = passwordPageData?.screen?.componentTree?.nodes || [];
              const signInNode = findNode(pwNodes, 'sign-in-button') || findNode(pwNodes, 'continue-button');
              const signInSU = extractSU(signInNode?.onPress);
              if (!signInSU) return { error: '未找到提交按钮', browserLogs };
              log('[browser] 已定位提交按钮');

              log('[browser] 获取 reCAPTCHA token...');
              const token = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('reCAPTCHA 超时')), 30000);
                window.grecaptcha.enterprise.ready(async () => {
                  try {
                    const t = await window.grecaptcha.enterprise.execute(RECAPTCHA_SITE_KEY, { action: 'login' });
                    clearTimeout(timer);
                    resolve(t);
                  } catch (e) {
                    clearTimeout(timer);
                    reject(e);
                  }
                });
              });
              log(`[browser] 获得 reCAPTCHA token (长度 ${token.length})`);

              log('[browser] 提交密码 GraphQL...');
              // 从页面 locale 推导 countryCode/countryIsoCode（避免与 IP 地理位置矛盾）
              const COUNTRY_MAP = {
                'hk': { code: '852', iso: 'HK' },
                'tw': { code: '886', iso: 'TW' },
                'sg': { code: '65',  iso: 'SG' },
                'jp': { code: '81',  iso: 'JP' },
                'kr': { code: '82',  iso: 'KR' },
                'us': { code: '1',   iso: 'US' },
                'gb': { code: '44',  iso: 'GB' },
                'de': { code: '49',  iso: 'DE' },
              };
              const cc = (PAGE_LOCALE.split('-')[0] || 'us').toLowerCase();
              const country = COUNTRY_MAP[cc] || COUNTRY_MAP.us;
              log(`[browser] countryCode=${country.code}, countryIsoCode=${country.iso}`);

              const loginResp = await gql({
                serverState,
                serverScreenUpdate: signInSU,
                inputFields: [
                  { name: 'password', value: { stringValue: password } },
                  { name: 'userLoginId', value: { stringValue: email } },
                  { name: 'countryCode', value: { stringValue: country.code } },
                  { name: 'countryIsoCode', value: { stringValue: country.iso } },
                  { name: 'recaptchaResponseToken', value: { stringValue: token } },
                  { name: 'recaptchaResponseTime', value: { intValue: Math.floor(150 + Math.random() * 250) } },
                ],
              });

              if (loginResp?.errors?.length) return { error: loginResp.errors[0].message, browserLogs };
              const loginResult = loginResp?.data?.result;
              log(`[browser] 密码提交响应: outcome=${loginResult?.outcomeType}, screen=${loginResult?.screen?.loggingViewName || 'none'}`);

              const loginNodes = loginResult?.screen?.componentTree?.nodes || [];
              const errNode = findNode(loginNodes, 'alert-message-body');
              const errText = errNode?.webTextWithTags?.text?.value || errNode?.plainContent?.value;
              if (errText) {
                // 把当时提交的字段名打出来便于排查（不打印密码本身）
                const fieldNames = [
                  'password', 'userLoginId', 'countryCode', 'countryIsoCode',
                  'recaptchaResponseToken', 'recaptchaResponseTime', 'recaptchaError',
                ].join(',');
                log(`[browser] 提交字段: ${fieldNames}; loggingView=${loginResult?.screen?.loggingViewName}; trackingScreen=${(() => { try { return JSON.parse(loginResult?.screen?.trackingInfo || '{}')?.screenName; } catch { return ''; } })()}`);
                return { error: errText, browserLogs };
              }

              log('[browser] 密码提交成功，等待 Cookie');
              return { success: true, browserLogs };
            } catch (err) {
              return { error: err.message, browserLogs };
            }
          },
          { email, password, emailRespData, isOtpPage, GRAPHQL_URL, PERSISTED_QUERY_CLCS, RECAPTCHA_SITE_KEY, TARGET_LOCALE },
        ).catch((e) => {
          // 页面跳转导致 context 销毁 = 登录成功
          if (e.message.includes('Execution context was destroyed') || e.message.includes('navigation')) {
            return { success: true, browserLogs: ['[browser] 页面跳转导致 context 销毁（视为成功）'] };
          }
          return { error: e.message, browserLogs: [] };
        });

        (evalResult?.browserLogs || []).forEach((l) => logger.info('NetflixLogin', l));

        if (evalResult?.error) {
          logger.warn('NetflixLogin', `[13] 浏览器内流程失败: ${evalResult.error}`);
          return { success: false, cookies: null, error: evalResult.error };
        }
        logger.info('NetflixLogin', `[13] 浏览器内流程完成 (${elapsed()})`);
      }

      // ========== 11. 动态等 NetflixId Cookie（轮询 50ms）==========
      logger.info('NetflixLogin', `[14] 等待 Set-Cookie... 当前页面: ${page.url()}`);
      const cookieWaitStart = Date.now();
      let cookies = [];
      let netflixId = null;
      while (Date.now() - cookieWaitStart < 5000) {
        cookies = await context.cookies('https://www.netflix.com');
        netflixId = cookies.find((c) => c.name === 'NetflixId');
        if (netflixId && netflixId.value.length > 500) break;
        await page.waitForTimeout(50);
      }

      // ========== 12. 提取 Cookie ==========
      const secureNetflixId = cookies.find((c) => c.name === 'SecureNetflixId');
      const isRealLogin = !!(netflixId && netflixId.value.length > 500 && secureNetflixId);
      logger.info('NetflixLogin', `[15] 提取到 ${cookies.length} 个 Cookie, NetflixId 长度=${netflixId?.value?.length || 0}, 真实登录=${isRealLogin}, 当前页面=${page.url()}, 等待 Cookie 耗时=${Date.now() - cookieWaitStart}ms`);

      if (isRealLogin) {
        // worker 模式：不写本地数据库，直接把 cookies 返回给云端
        logger.success('NetflixLogin', `[17] 登录成功: ${email} (总耗时 ${elapsed()}, ${cookies.length} 个 cookies)`);
        return { success: true, cookies, error: null };
      }

      logger.warn('NetflixLogin', `[16] 登录失败: 未获取到有效 Cookie (总耗时 ${elapsed()})`);
      return { success: false, cookies: null, error: '登录失败：未获取到有效登录 Cookie' };
    } catch (err) {
      // 已 abort（用户取消）→ 安静返回，不打印错误
      if (this._aborted) {
        return { success: false, cookies: null, error: '用户取消', cancelled: true };
      }
      // 将 Playwright 内部错误翻译为用户友好的提示
      const msg = err.message || '';
      let userError;
      if (/Target.*closed|browser has been closed/i.test(msg)) {
        userError = '浏览器被意外关闭（可能是内存不足或手动关闭了窗口）';
      } else if (/Timeout/i.test(msg)) {
        userError = '操作超时（页面加载过慢或网络不通）';
      } else if (/net::ERR_PROXY/i.test(msg)) {
        userError = '代理连接失败，请检查代理配置';
      } else if (/net::ERR_/i.test(msg)) {
        userError = `网络错误：${msg.match(/net::\w+/)?.[0] || msg}`;
      } else if (/Execution context was destroyed|navigation/i.test(msg)) {
        userError = '页面跳转导致操作中断';
      } else {
        userError = msg;
      }
      logger.error('NetflixLogin', `异常: ${msg}`);
      return { success: false, cookies: null, error: userError };
    } finally {
      // 释放 context 回 pool（不关闭主进程）
      if (poolHandle) {
        const browserPool = require('./browserPool');
        try { await browserPool.release(poolHandle); } catch {}
      }
    }
  }

  _findNode(nodes, testId) {
    if (!Array.isArray(nodes)) return null;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (node.testId === testId) return node;
      for (const key of Object.keys(node)) {
        const val = node[key];
        if (Array.isArray(val)) { const f = this._findNode(val, testId); if (f) return f; }
        else if (val && typeof val === 'object') { const f = this._findNode([val], testId); if (f) return f; }
      }
    }
    return null;
  }
}

module.exports = LoginService;
