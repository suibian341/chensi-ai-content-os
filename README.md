# chensi-ai-content-os（辰思 AI 内容系统）

Node.js 全栈项目：内容生产、素材管理、数字人 / 配音、发布与视频任务调度。

## 技术栈

- 后端：Node.js（`backend/server.js`），本地 JSON 存储（`runtime-data/`），可选 PostgreSQL / Redis
- 前端：`web/`（Vite 构建的静态站点，由后端托管）
- 能力：大模型文案、图片生成、TTS / 声音克隆、数字人视频、自动剪辑任务派发

## 本地运行

```bash
npm install
npm start          # 同时起 API(4280) 和 Web(4273)
```

打开 <http://localhost:4273>。

## 配置

复制 `backend/env.production.example` 为 `backend/.env`，按需填写：

| 变量 | 说明 |
|---|---|
| `IP_AGENT_LLM_*` | 文本 / 多模态模型接入（OpenAI 兼容） |
| `IP_AGENT_VOLCENGINE_*` | 火山语音合成 / 声音克隆 |
| `IP_AGENT_SKYHUMAN_*` | 数字人（HeyGen 兼容） |
| `IP_AGENT_STORAGE_DRIVER` | `local` 或 `oss` |
| `IP_AGENT_POSTGRES_URL` | 换成 PostgreSQL 时填写 |

> `.env` 已被 gitignore，仓库里不含任何真实 Key。

## 目录

```
backend/             API、模型接入、存储、任务派发
backend/storage/     本地素材（gitignore）
web/                 前端构建产物与静态资源
runtime-data/        运行期数据（gitignore）
scripts/             运维与导入脚本
```

## 相关仓库

- 视频渲染服务：`chensi-video-render-service`（本仓库通过 HTTP 调用它）
