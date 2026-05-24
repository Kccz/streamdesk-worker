<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useWorkerStore } from '../stores/worker'

const store = useWorkerStore()
const platform = ref('')
const arch = ref('')

onMounted(() => {
  // 简单从 navigator userAgent 推导
  const ua = navigator.userAgent
  if (/Mac/i.test(ua)) platform.value = 'macOS'
  else if (/Windows/i.test(ua)) platform.value = 'Windows'
  else if (/Linux/i.test(ua)) platform.value = 'Linux'
  else platform.value = '-'
  arch.value = (navigator as any)?.userAgentData?.platform || ''
})

const features = [
  { icon: '🎯', title: '云端任务派发', desc: '通过 long-polling 拉取登录任务' },
  { icon: '🛡', title: '本地浏览器执行', desc: '真实 Chrome 反风控 + 代理支持' },
  { icon: '🔐', title: '凭据加密', desc: 'token 存储在系统钥匙串' },
  { icon: '⚡', title: '自动更新', desc: '检测新版本自动下载安装' },
]

async function openLogs(): Promise<void> {
  await window.api.openLogDir()
}

const checking = ref(false)
async function checkUpdate(): Promise<void> {
  checking.value = true
  try {
    const r = await window.api.checkUpdate()
    const t = (window as any).__toast
    if (r.ok) {
      t?.success('检查完成', r.message || '已开始检查')
    } else {
      t?.warning('检查失败', r.message || '请稍后重试')
    }
  } finally {
    checking.value = false
  }
}
</script>

<template>
  <div class="about">
    <!-- 页面标题 -->
    <header class="page-head">
      <h1>关于</h1>
      <p class="muted">应用版本与系统信息</p>
    </header>

    <!-- Logo + 版本 -->
    <section class="hero">
      <div class="hero-logo">
        <span class="hero-letter">S</span>
      </div>
      <h2>StreamDesk Worker</h2>
      <div class="version-tag">v{{ store.appVersion }}</div>
      <p class="hero-desc">流媒体账号自动化登录客户端</p>
    </section>

    <!-- 系统信息 -->
    <section class="card info-card">
      <div class="card-title">运行环境</div>
      <div class="info-list">
        <div class="info-row">
          <span class="info-label">操作系统</span>
          <span class="info-value">{{ platform }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">应用版本</span>
          <span class="info-value mono">v{{ store.appVersion }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">设备 ID</span>
          <span class="info-value mono">{{ store.config?.workerId || '-' }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">服务器</span>
          <span class="info-value mono">{{ store.config?.server || '-' }}</span>
        </div>
      </div>
    </section>

    <!-- 功能特性 -->
    <section class="features">
      <div class="card-title">主要能力</div>
      <div class="features-grid">
        <div v-for="f in features" :key="f.title" class="feature-card">
          <div class="feature-icon">{{ f.icon }}</div>
          <div class="feature-title">{{ f.title }}</div>
          <div class="feature-desc">{{ f.desc }}</div>
        </div>
      </div>
    </section>

    <!-- 操作 -->
    <section class="card actions-card">
      <div class="card-title">维护</div>
      <div class="action-row">
        <div>
          <div class="action-title">检查更新</div>
          <div class="action-desc">手动从远端检查是否有新版本</div>
        </div>
        <button class="btn" :disabled="checking" @click="checkUpdate">
          {{ checking ? '检查中...' : '检查更新' }}
        </button>
      </div>
      <div class="action-divider" />
      <div class="action-row">
        <div>
          <div class="action-title">查看日志目录</div>
          <div class="action-desc">在文件管理器中打开应用日志所在目录</div>
        </div>
        <button class="btn" @click="openLogs">打开</button>
      </div>
    </section>

    <footer class="copyright">
      © 2026 StreamDesk · All rights reserved
    </footer>
  </div>
</template>

<style scoped>
.about {
  max-width: 720px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding-bottom: 12px;
}

.page-head h1 {
  font-size: 18px;
  font-weight: 600;
}
.page-head .muted {
  font-size: 12px;
  margin-top: 2px;
}

/* Hero */
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 28px 20px 24px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: var(--shadow-sm);
}
.hero-logo {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  background: linear-gradient(135deg, var(--primary) 0%, #ff7043 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
  box-shadow: 0 8px 24px rgba(239, 83, 80, 0.3);
}
.hero-letter {
  color: #fff;
  font-weight: 800;
  font-size: 30px;
  font-family: 'SF Pro Display', -apple-system, sans-serif;
}
h2 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 6px;
}
.version-tag {
  display: inline-flex;
  background: var(--primary-soft);
  color: var(--primary);
  padding: 3px 10px;
  border-radius: 12px;
  font-family: 'Menlo', monospace;
  font-size: 11px;
  font-weight: 600;
  margin-bottom: 10px;
}
.hero-desc {
  font-size: 12px;
  color: var(--text-muted);
}

/* 卡片通用 */
.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 18px;
  box-shadow: var(--shadow-sm);
}
.card-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 12px;
}

/* 信息列表 */
.info-list {
  display: flex;
  flex-direction: column;
}
.info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.info-row:last-child {
  border-bottom: none;
}
.info-label {
  color: var(--text-muted);
  font-size: 12px;
}
.info-value {
  font-weight: 500;
}
.info-value.mono {
  font-family: 'Menlo', monospace;
  font-size: 11px;
  background: var(--bg-soft);
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
}

/* 特性卡 */
.features-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  margin-top: 4px;
}
.feature-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: all 0.15s;
}
.feature-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
}
.feature-icon {
  font-size: 18px;
  margin-bottom: 4px;
}
.feature-title {
  font-size: 13px;
  font-weight: 600;
}
.feature-desc {
  font-size: 11px;
  color: var(--text-muted);
}

/* 操作 */
.actions-card .action-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.action-divider {
  height: 1px;
  background: var(--border);
  margin: 12px 0;
}
.action-title {
  font-size: 13px;
  font-weight: 500;
}
.action-desc {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}

.copyright {
  text-align: center;
  font-size: 11px;
  color: var(--text-subtle);
  padding: 8px 0;
}
</style>
