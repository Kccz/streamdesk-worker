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

const OTP_API_ENDPOINT = process.env.OTP_API_ENDPOINT || 'https://yzm.4knaifei.cn/index/index/getCdkData';

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
    const otpOptions = buildOtpOptions();
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

        if (otpOptions.enabled) {
          await page.exposeFunction('__streamDeskWorkerGetOtpCode', async (payload = {}) => {
            return pollThirdPartyOtpCode({ email, password }, otpOptions, payload);
          });
        }

        const evalResult = await page.evaluate(
          async ({
            email,
            password,
            otpCode,
            otpApiEnabled,
            otpApiInitialDelayMs,
            otpApiWrongCodeRetryCycles,
            emailRespData,
            isOtpPage,
            GRAPHQL_URL,
            PERSISTED_QUERY_CLCS,
            RECAPTCHA_SITE_KEY,
            TARGET_LOCALE,
          }) => {
            const browserLogs = [];
            const log = (msg) => browserLogs.push(msg);
            const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

            function findByLabel(nodes, label) {
              if (!Array.isArray(nodes)) return null;
              for (const node of nodes) {
                if (!node || typeof node !== 'object') continue;
                const text = node.label?.value
                  || node.webTextWithTags?.text?.value
                  || node.plainContent?.value
                  || node.text?.value
                  || '';
                if (text === label) return node;
                for (const value of Object.values(node)) {
                  if (Array.isArray(value)) {
                    const found = findByLabel(value, label);
                    if (found) return found;
                  } else if (value && typeof value === 'object') {
                    const found = findByLabel([value], label);
                    if (found) return found;
                  }
                }
              }
              return null;
            }

            function findInputRequirement(node, inputKind) {
              if (!node || typeof node !== 'object') return null;
              if (Array.isArray(node)) {
                for (const child of node) {
                  const found = findInputRequirement(child, inputKind);
                  if (found) return found;
                }
                return null;
              }

              const requirements = node.inputFieldRequirements;
              if (Array.isArray(requirements)) {
                return requirements.find((item) => item?.field?.loggingInputKind === inputKind)
                  || requirements[0]
                  || null;
              }

              for (const child of Object.values(node)) {
                const found = findInputRequirement(child, inputKind);
                if (found) return found;
              }
              return null;
            }

            function findNodeByKey(nodes, key) {
              if (!Array.isArray(nodes) || !key) return null;
              for (const node of nodes) {
                if (!node || typeof node !== 'object') continue;
                if (node.key === key) return node;
                for (const value of Object.values(node)) {
                  if (Array.isArray(value)) {
                    const found = findNodeByKey(value, key);
                    if (found) return found;
                  } else if (value && typeof value === 'object') {
                    const found = findNodeByKey([value], key);
                    if (found) return found;
                  }
                }
              }
              return null;
            }

            function textFromNode(node) {
              return node?.webTextWithTags?.text?.value
                || node?.plainContent?.value
                || node?.richContent?.value
                || node?.label?.value
                || node?.text?.value
                || '';
            }

            function alertTextFromResult(result) {
              const nodes = result?.screen?.componentTree?.nodes || [];
              const node = findNode(nodes, 'alert-message-body');
              const directText = textFromNode(node);
              if (directText) return directText;

              const collectAlert = findNode(nodes, 'collect-input-alert-WARNING')
                || findNode(nodes, 'collect-input-alert-ERROR')
                || findNode(nodes, 'collect-input-alert');
              const contentKey = collectAlert?.content?.key;
              const contentText = textFromNode(contentKey ? findNodeByKey(nodes, contentKey) : collectAlert?.content);
              return contentText || textFromNode(collectAlert);
            }

            function isWrongOtpAlert(text) {
              return /wasn't quite right|incorrect code|code.*incorrect|验证码.*(错误|不正确)|驗證碼.*(錯誤|不正確)|代碼.*(錯誤|不正確)/i.test(String(text || ''));
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

              const loginScreenView = loginResult?.screen?.loggingViewName || '';
              if (loginScreenView === 'mfaSelectFactor') {
                log('[browser] 检测到 MFA 选择页，查找 account-mfa-button-OTP_EMAIL...');
                const otpEmailNode = findNode(loginNodes, 'account-mfa-button-OTP_EMAIL');
                if (otpEmailNode) {
                  const otpEmailSU = extractSU(otpEmailNode?.onPress);
                  if (!otpEmailSU) return { error: '找到 OTP_EMAIL 但未找到 serverScreenUpdate', browserLogs };

                  log('[browser] 自动选择 Email a code...');
                  const otpSelectResp = await gql({
                    serverState: loginResult?.screen?.serverState || serverState,
                    serverScreenUpdate: otpEmailSU,
                    inputFields: [],
                  });

                  if (otpSelectResp?.errors?.length) return { error: otpSelectResp.errors[0].message, browserLogs };
                  const otpSelectResult = otpSelectResp?.data?.result;
                  log(`[browser] OTP_EMAIL 响应: outcome=${otpSelectResult?.outcomeType}, screen=${otpSelectResult?.screen?.loggingViewName || 'none'}`);

                  const otpSelectErrText = alertTextFromResult(otpSelectResult);
                  if (otpSelectErrText) return { error: otpSelectErrText, browserLogs };

                  const otpScreenView = otpSelectResult?.screen?.loggingViewName || '';
                  if (otpScreenView === 'CollectOtpInput' || otpScreenView === 'collectOtpInput') {
                    if (otpApiEnabled) {
                      log(`[browser] 检测到验证码输入页，等待 ${otpApiInitialDelayMs}ms 后查询第三方验证码`);
                      await delay(otpApiInitialDelayMs);

                      if (typeof window.__streamDeskWorkerGetOtpCode !== 'function') {
                        return { error: '验证码 API bridge 未安装', browserLogs };
                      }
                    }

                    const maxSubmitAttempts = otpApiEnabled ? 1 + otpApiWrongCodeRetryCycles : 1;
                    const triedCodes = [];
                    let currentOtpResult = otpSelectResult;
                    let lastOtpError = null;

                    for (let submitAttempt = 1; submitAttempt <= maxSubmitAttempts; submitAttempt += 1) {
                      const currentOtpNodes = currentOtpResult?.screen?.componentTree?.nodes || [];
                      const submitNode = findByLabel(currentOtpNodes, 'Submit')
                        || findNode(currentOtpNodes, 'collect-input-submit-cta')
                        || findNode(currentOtpNodes, 'collect-otp-submit');
                      const submitSU = extractSU(submitNode?.onPress);
                      if (!submitSU) return { error: '验证码页未找到 Submit serverScreenUpdate', browserLogs };

                      const requirement = findInputRequirement(submitNode?.onPress, 'smsCode')
                        || findInputRequirement(submitNode, 'smsCode');
                      const otpFieldName = requirement?.name
                        || requirement?.inputFieldName
                        || requirement?.fieldName
                        || requirement?.field?.id
                        || requirement?.field?.loggingInputKind
                        || 'challengeOtp';

                      let code = '';
                      if (otpApiEnabled) {
                        const otpApiResult = await window.__streamDeskWorkerGetOtpCode({
                          excludeCodes: triedCodes,
                        });
                        code = String(otpApiResult?.code || '').trim();
                        if (!otpApiResult?.success || !/^\d{6}$/.test(code)) {
                          return { error: otpApiResult?.error || '验证码接口未返回 6 位数字', browserLogs };
                        }
                        log(`[browser] 第三方验证码查询成功 attempt=${otpApiResult.attempt || 'unknown'}, submitAttempt=${submitAttempt}/${maxSubmitAttempts}`);
                      } else {
                        code = String(otpCode || '').trim();
                        if (!/^\d{6}$/.test(code)) {
                          return { error: `OTP_CODE 必须是 6 位数字，当前长度=${code.length}`, browserLogs };
                        }
                        log('[browser] 检测到验证码输入页，使用本地 OTP_CODE');
                      }

                      triedCodes.push(code);
                      log(`[browser] 提交验证码字段 ${otpFieldName}=****** (${submitAttempt}/${maxSubmitAttempts})`);
                      const otpSubmitResp = await gql({
                        serverState: currentOtpResult?.screen?.serverState || loginResult?.screen?.serverState || serverState,
                        serverScreenUpdate: submitSU,
                        inputFields: [
                          { name: otpFieldName, value: { stringValue: code } },
                        ],
                      });

                      if (otpSubmitResp?.errors?.length) return { error: otpSubmitResp.errors[0].message, browserLogs };
                      const otpSubmitResult = otpSubmitResp?.data?.result;
                      log(`[browser] 验证码提交响应: outcome=${otpSubmitResult?.outcomeType}, screen=${otpSubmitResult?.screen?.loggingViewName || 'none'}, status=${otpSubmitResult?.status || 'none'}`);

                      const otpSubmitErrText = alertTextFromResult(otpSubmitResult);
                      if (otpSubmitErrText) {
                        lastOtpError = otpSubmitErrText;
                        log(`[browser] 验证码提交返回提示: ${otpSubmitErrText}`);
                        if (otpApiEnabled && isWrongOtpAlert(otpSubmitErrText) && submitAttempt < maxSubmitAttempts) {
                          currentOtpResult = otpSubmitResult;
                          log('[browser] 验证码错误，继续轮询第三方接口后重试');
                          continue;
                        }
                        return { error: otpSubmitErrText, browserLogs };
                      }

                      return {
                        success: true,
                        browserLogs,
                        mfaSelected: 'OTP_EMAIL',
                        otpSubmitted: true,
                        otpSubmitAttempts: submitAttempt,
                        otpOutcome: otpSubmitResult?.outcomeType || null,
                        otpScreen: otpSubmitResult?.screen?.loggingViewName || null,
                      };
                    }

                    return { error: lastOtpError || '验证码重试次数已用完', browserLogs };
                  }

                  log('[browser] 已选择邮箱验证码，等待后续验证码步骤或 Cookie');
                  return {
                    success: true,
                    browserLogs,
                    mfaSelected: 'OTP_EMAIL',
                    mfaOutcome: otpSelectResult?.outcomeType || null,
                    mfaScreen: otpSelectResult?.screen?.loggingViewName || null,
                  };
                }

                log('[browser] 未找到 account-mfa-button-OTP_EMAIL，保持原流程等待 Cookie');
              }

              log('[browser] 密码提交成功，等待 Cookie');
              return { success: true, browserLogs };
            } catch (err) {
              return { error: err.message, browserLogs };
            }
          },
          {
            email,
            password,
            otpCode: otpOptions.fallbackCode,
            otpApiEnabled: otpOptions.enabled,
            otpApiInitialDelayMs: otpOptions.initialDelayMs,
            otpApiWrongCodeRetryCycles: otpOptions.wrongCodeRetryCycles,
            emailRespData,
            isOtpPage,
            GRAPHQL_URL,
            PERSISTED_QUERY_CLCS,
            RECAPTCHA_SITE_KEY,
            TARGET_LOCALE,
          },
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
      const msg = err?.message || String(err);
      logger.error('NetflixLogin', `异常: ${msg}`);
      return { success: false, cookies: null, error: msg };
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

function buildOtpOptions() {
  return {
    enabled: process.env.OTP_API !== '0',
    initialDelayMs: parsePositiveInt(process.env.OTP_API_DELAY_MS, 20000),
    maxAttempts: parsePositiveInt(process.env.OTP_API_ATTEMPTS, 20),
    retryDelayMs: parsePositiveInt(process.env.OTP_API_INTERVAL_MS, 1000),
    wrongCodeRetryCycles: parseNonNegativeInt(process.env.OTP_API_WRONG_RETRIES, 1),
    fallbackCode: process.env.OTP_CODE || process.env.LOGIN_OTP_CODE || '',
  };
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  if (value === '0') return 0;
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function pollThirdPartyOtpCode(credentials, otpOptions, options = {}) {
  const maxAttempts = otpOptions.maxAttempts;
  const excludeCodes = new Set((options.excludeCodes || []).map((code) => String(code).trim()).filter(Boolean));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await queryThirdPartyVerificationCode(credentials.email, credentials.password);
      if (result?.success === false) {
        logger.info('NetflixLogin', `[otp-api] 第 ${attempt}/${maxAttempts} 次 API 返回失败: ${result.message || 'unknown'}`);
        if (attempt < maxAttempts) await sleep(otpOptions.retryDelayMs);
        continue;
      }

      const extracted = extractVerificationCode(result);

      if (/^\d{6}$/.test(extracted.code || '')) {
        if (excludeCodes.has(extracted.code)) {
          logger.info('NetflixLogin', `[otp-api] 第 ${attempt}/${maxAttempts} 次仍是已提交过的验证码，继续等待新码`);
          if (attempt < maxAttempts) await sleep(otpOptions.retryDelayMs);
          continue;
        }
        logger.info('NetflixLogin', `[otp-api] 第 ${attempt}/${maxAttempts} 次获取到 6 位验证码`);
        return { success: true, code: extracted.code, attempt };
      }

      if (extracted.candidate) {
        logger.info('NetflixLogin', `[otp-api] 第 ${attempt}/${maxAttempts} 次返回候选值但不是 6 位: ${describeCodeCandidate(extracted.candidate)}`);
      } else {
        logger.info('NetflixLogin', `[otp-api] 第 ${attempt}/${maxAttempts} 次未提取到验证码字段`);
      }
    } catch (err) {
      logger.info('NetflixLogin', `[otp-api] 第 ${attempt}/${maxAttempts} 次查询异常: ${err.message}`);
    }

    if (attempt < maxAttempts) await sleep(otpOptions.retryDelayMs);
  }

  return {
    success: false,
    error: `验证码接口连续 ${maxAttempts} 次未返回可用的新 6 位数字`,
  };
}

async function queryThirdPartyVerificationCode(email, password) {
  const cdk = `${email}----${password}`;
  const response = await fetch(OTP_API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json, text/plain, */*',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({ cdk }),
  });

  if (!response.ok) {
    return {
      success: false,
      message: `API 请求失败: ${response.status} ${response.statusText}`,
    };
  }

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  const explicitSuccess = data.code === 0 || data.success === true || data.type === 'success';
  const explicitFailure = data.success === false
    || (data.code !== undefined && data.code !== 0)
    || ['error', 'fail', 'failed'].includes(String(data.type || '').toLowerCase());

  if (explicitSuccess || !explicitFailure) {
    return {
      success: true,
      message: 'API 查询成功',
      apiData: data.data || data,
    };
  }

  return {
    success: false,
    message: data.msg || data.message || 'API 查询失败',
  };
}

function extractVerificationCode(result) {
  const apiData = result?.apiData || result || null;
  const candidates = [];
  const add = (value) => {
    if (value !== null && value !== undefined && value !== '') candidates.push(value);
  };

  add(apiData?.result?.code);
  add(apiData?.data?.result?.code);
  add(apiData?.data?.code);
  add(apiData?.captcha);
  add(apiData?.verificationCode);
  collectFieldValues(apiData, ['code', 'captcha', 'verificationCode'], candidates);

  let firstCandidate = null;
  for (const candidate of candidates) {
    const text = String(candidate).trim();
    if (!text || text === '0') continue;
    if (!firstCandidate) firstCandidate = text;
    if (/^\d{6}$/.test(text)) return { code: text, candidate: text };
  }

  return { code: null, candidate: firstCandidate };
}

function collectFieldValues(payload, fieldNames, output, seen = new Set()) {
  if (!payload || typeof payload !== 'object') return;
  if (seen.has(payload)) return;
  seen.add(payload);

  const names = new Set(fieldNames.map((name) => String(name).toLowerCase()));
  if (Array.isArray(payload)) {
    for (const item of payload) collectFieldValues(item, fieldNames, output, seen);
    return;
  }

  for (const [key, value] of Object.entries(payload)) {
    if (names.has(String(key).toLowerCase()) && value !== null && value !== undefined && value !== '') {
      output.push(value);
    }
    if (value && typeof value === 'object') collectFieldValues(value, fieldNames, output, seen);
  }
}

function describeCodeCandidate(value) {
  const text = String(value || '').trim();
  if (!text) return 'empty';
  if (/^https?:\/\//i.test(text)) return `url(len=${text.length})`;
  return `len=${text.length}, digitsOnly=${/^\d+$/.test(text)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = LoginService;
