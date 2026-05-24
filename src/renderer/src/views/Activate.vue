<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useWorkerStore } from '../stores/worker'

const store = useWorkerStore()
const STORAGE_KEY = 'activate-form'

const server = ref('https://test.streamdesk.cc.cd')
const code = ref('')
const deviceName = ref('')
const loading = ref(false)

onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    if (saved.server) server.value = saved.server
    if (saved.deviceName) deviceName.value = saved.deviceName
    // 激活码不持久化（敏感信息）
  } catch {
    /* ignore */
  }
})

async function handleActivate(): Promise<void> {
  if (!server.value || !code.value) {
    ;(window as any).__toast?.warning('请填写完整', '服务器地址和激活码不能为空')
    return
  }
  loading.value = true
  try {
    const res = await window.api.activate({
      server: server.value,
      code: code.value.trim(),
      deviceName: deviceName.value.trim(),
    })
    if (res.ok) {
      try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
      await store.refresh()
      ;(window as any).__toast?.success('激活成功', `节点 ${res.workerId}`)
    } else {
      ;(window as any).__toast?.error('激活失败', res.error || '未知错误')
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          server: server.value,
          deviceName: deviceName.value,
        }))
      } catch { /* ignore */ }
    }
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="activate">
    <div class="bg-blob blob-1" />
    <div class="bg-blob blob-2" />

    <div class="panel">
      <div class="brand">
        <div class="logo">
          <span class="logo-letter">S</span>
        </div>
        <h1>StreamDesk Worker</h1>
        <p class="muted">激活设备，开始接收云端任务</p>
      </div>

      <div class="form">
        <label>
          <span>服务器地址</span>
          <div class="input-wrap">
            <span class="prefix">URL</span>
            <input v-model="server" placeholder="https://your-server.com" />
          </div>
        </label>
        <label>
          <span>激活码</span>
          <div class="input-wrap">
            <span class="prefix">CODE</span>
            <input
              v-model="code"
              placeholder="管理员在后台节点页面创建后获取"
              @keydown.enter="handleActivate"
            />
          </div>
        </label>
        <label>
          <span>设备名称（可选）</span>
          <div class="input-wrap">
            <span class="prefix">NAME</span>
            <input
              v-model="deviceName"
              placeholder="留空使用主机名"
              @keydown.enter="handleActivate"
            />
          </div>
        </label>

        <button class="btn btn-primary big" :disabled="loading" @click="handleActivate">
          <span v-if="loading" class="spinner" />
          {{ loading ? '正在激活...' : '激活设备' }}
        </button>

        <div class="footer-hint muted">
          在云端「执行节点」页面创建一个节点后，把它的 token 填到激活码栏
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.activate {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  position: relative;
  overflow: hidden;
  background: radial-gradient(ellipse at top, #ffffff 0%, var(--bg) 60%);
}
.bg-blob {
  position: absolute;
  width: 360px;
  height: 360px;
  border-radius: 50%;
  filter: blur(80px);
  opacity: 0.18;
  pointer-events: none;
}
.blob-1 {
  background: var(--primary);
  top: -80px;
  right: -80px;
}
.blob-2 {
  background: #29b6f6;
  bottom: -80px;
  left: -80px;
}

.panel {
  position: relative;
  width: 100%;
  max-width: 440px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 36px 32px;
  box-shadow: var(--shadow-lg);
  -webkit-app-region: no-drag;
}
.brand {
  text-align: center;
  margin-bottom: 28px;
}
.logo {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  background: linear-gradient(135deg, var(--primary) 0%, #ff7043 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 14px;
  box-shadow: 0 6px 20px rgba(239, 83, 80, 0.35);
}
.logo-letter {
  color: #fff;
  font-weight: 800;
  font-size: 24px;
  font-family: 'SF Pro Display', -apple-system, sans-serif;
}
h1 {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 6px;
}
.muted {
  font-size: 12px;
  color: var(--text-muted);
}

.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 500;
  letter-spacing: 0.3px;
  text-transform: uppercase;
}
.input-wrap {
  display: flex;
  align-items: stretch;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  transition: all 0.15s;
}
.input-wrap:focus-within {
  border-color: var(--primary);
  background: var(--bg-elev);
  box-shadow: 0 0 0 3px var(--primary-soft);
}
.prefix {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  background: var(--bg-elev);
  color: var(--text-muted);
  font-size: 10px;
  font-family: 'Menlo', monospace;
  font-weight: 600;
  letter-spacing: 0.5px;
  border-right: 1px solid var(--border);
  min-width: 50px;
}
.input-wrap input {
  flex: 1;
  background: transparent;
  border: none;
  padding: 10px 12px;
  outline: none;
  color: var(--text);
  font-size: 13px;
}

.btn.big {
  height: 42px;
  font-size: 14px;
  font-weight: 600;
  border-radius: 8px;
  margin-top: 4px;
}
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

.footer-hint {
  text-align: center;
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.6;
}
</style>
