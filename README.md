# chensi-ai-content-os（辰思 AI 内容系统）

Node.js 全栈项目：内容生产、素材管理、数字人 / 配音、发布与视频任务调度。
仓库里同时包含**视频渲染服务**（`video-render-service/`），两个服务同仓管理、各自独立进程运行。

## 仓库结构（单仓库双服务）

```
backend/               主应用 API、模型接入、存储、任务派发
web/                   前端静态站点（由主应用托管）
scripts/               运维与导入脚本
video-render-service/  视频渲染服务（独立进程，默认 4399）
runtime-data/          主应用运行期数据（gitignore）
```

| 服务 | 端口 | 启动 |
|---|---|---|
| 主应用（API + Web） | API `4280` / Web `4273` | `npm start` |
| 视频渲染服务 | `4399` | `cd video-render-service && npm start` |

主应用通过 `IP_AGENT_VIDEO_RENDER_SERVICE_URL` 调用渲染服务，两者可以用 HTTP 分开部署到不同机器。

## 主应用

```bash
npm install
npm start          # 同时起 API(4280) 和 Web(4273)
```

打开 <http://localhost:4273>。

### 配置

复制 `backend/env.production.example` 为 `backend/.env`，按需填写：

| 变量 | 说明 |
|---|---|
| `IP_AGENT_LLM_*` | 文本 / 多模态模型接入（OpenAI 兼容） |
| `IP_AGENT_VOLCENGINE_*` | 火山语音合成 / 声音克隆 |
| `IP_AGENT_SKYHUMAN_*` | 数字人（HeyGen 兼容） |
| `IP_AGENT_STORAGE_DRIVER` | `local` 或 `oss` |
| `IP_AGENT_POSTGRES_URL` | 换成 PostgreSQL 时填写 |
| `IP_AGENT_VIDEO_RENDER_SERVICE_URL/API_KEY` | 指向渲染服务 |

> `.env` 已被 gitignore，仓库里不含任何真实 Key。

## 视频渲染服务（video-render-service/）

把视频工坊的三种成片模式拆成独立服务：AI 自动剪辑（`vlog`）、口播去停顿（`talking-head`）、行业高光剪辑（`industry-viral`）。

```bash
cd video-render-service
cp .env.example .env     # 填 VIDEO_RENDER_API_KEY
npm start                # 监听 4399，GET /health 自检
```

依赖：FFmpeg / FFprobe、Python + faster-whisper、opencc。接口与部署细节见
[`video-render-service/README.md`](video-render-service/README.md)。

> 渲染服务用到 `-filter_complex` 内联滤镜图：`-filter_complex_script` 在 ffmpeg 9 已被移除，
> 用旧参数在 ffmpeg 8+ 上会报 `VIDEO_TRANSITION_FAILED`。
