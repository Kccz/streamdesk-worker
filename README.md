# StreamDesk Worker 桌面客户端

Electron + Vue 3 + TypeScript 实现的 Worker 桌面应用，跨 macOS / Windows / Linux。

## 开发

```bash
pnpm install
pnpm dev
```

## 打包

```bash
pnpm build:mac     # macOS dmg + zip
pnpm build:win     # Windows nsis 安装包
pnpm build:linux   # Linux AppImage
```

## 目录结构

```
src/
├── main/            # Electron 主进程（Node 环境）
│   ├── index.ts     # 入口（窗口 / tray / 生命周期）
│   ├── ipc.ts       # IPC 处理
│   ├── logger.ts    # 日志（控制台 + 文件 + 内存环 + 推 IPC）
│   └── core/
│       ├── pollClient.ts        # long-polling 客户端
│       ├── settings.ts          # electron-store 持久化
│       ├── credentials.ts       # keytar 钥匙串
│       ├── browserPool.cjs      # 浏览器池（沿用 worker.js）
│       ├── loginService.cjs     # Netflix 登录（沿用 worker.js）
│       └── manualOperate.cjs    # 真人介入（沿用 worker.js）
├── preload/         # 渲染进程暴露 API
│   ├── index.ts
│   └── index.d.ts
├── renderer/        # Vue 3 渲染进程
│   ├── index.html
│   └── src/
│       ├── main.ts
│       ├── App.vue
│       ├── views/{Activate,Dashboard,Settings}.vue
│       └── stores/worker.ts
└── shared/          # 主进程 / 渲染进程共用类型
    └── types.ts
```

## 后端协议

复用现有 backend：

- `POST /api/worker/activate` - 用激活码兑换 token（**待新增**）
- `GET  /api/worker/login/poll` - long polling 拉任务（已有）
- `POST /api/worker/login/complete` - 上报结果（已有）

## TODO

- [ ] 后端 `/api/worker/activate` 接口
- [ ] 后台「执行节点」生成激活码 UI
- [ ] 真人介入任务弹窗激活
- [ ] electron-updater 联调
- [ ] 签名 / 公证（Mac apple developer + 公证；Win EV cert）
- [ ] 托盘图标资源（resources/tray/iconTemplate.png）
