# 私有视频渲染服务（chensi-video-render-service）

把视频工坊的三种成片模式从主应用里拆出来，独立部署、独立扩缩容：

- AI 自动剪辑（`vlog`）
- 口播去停顿（`talking-head`）
- 行业爆款高光剪辑（`industry-viral`）

主应用可以继续用本地渲染器，也可以只改环境变量切到这个服务。素材以原始字节流上传，按租户 + SHA-256 缓存；渲染走带鉴权的异步队列。

## 启动

1. 复制 `.env.example` 为 `.env`，替换里面的 API Key。
2. 在私有机上装好 FFmpeg、FFprobe、Python、`faster-whisper`、`opencc-python-reimplemented`。
3. 执行 `npm start`。

Whisper 在 GPU 可用时默认走 CUDA + `float16`，否则自动回退到 CPU + `int8`，并吃满可用的逻辑核。模型优先从本地缓存解析，命中后不再联网校验，所以后续任务不会卡在模型仓库检查上。需要覆盖时改 `VIDEO_RENDER_WHISPER_DEVICE`、`VIDEO_RENDER_WHISPER_COMPUTE_TYPE`、`VIDEO_RENDER_WHISPER_CPU_THREADS`。

中文转写会先统一成简体，再进入语义匹配、字幕排版和烧录；检测到中文时必须有 OpenCC，避免线上悄悄输出繁体字幕。

服务默认监听 `0.0.0.0:4399`。启动日志会打印本机地址和所有探测到的局域网 IPv4 地址。API Key 不要外泄；应用服务器在另一台机器时，把地址配成 `http://<渲染机内网IP>:4399`。Windows 防火墙拦截入站时，只在专用网络配置里放行 TCP `4399`。

## 终端日志

服务把结构化生命周期日志打到 stdout：素材缓存命中/上传、入队、开始、引擎每次真实进度回调、产物校验、完成耗时、取消、超时、失败都会记录。进度按“已完成的处理阶段”计算，不做时间估算。

状态轮询和视频 Range 请求故意不进常规访问日志，避免刷屏。凭证、请求内容和原始租户标识不会打印。容器部署时用平台常规日志驱动收集同一份 stdout。

公网部署时，把服务绑到内网网卡，TLS 交给反向代理，**不要把渲染端口直接暴露给客户**。

也可以设置 `VIDEO_RENDER_API_KEY` 后执行 `docker compose -f compose.example.yml up -d --build`。示例 compose 会把 `4399` 发布到宿主机网络；`render-data` 和 `whisper-models` 两个卷要留在私有机上，端口不要直接映射到公网。

应用服务器侧这样配：

```dotenv
IP_AGENT_VIDEO_RENDER_SERVICE_URL=https://private-render.example.com
IP_AGENT_VIDEO_RENDER_SERVICE_API_KEY=the-matching-service-key
IP_AGENT_VIDEO_RENDER_SERVICE_TIMEOUT_MS=2700000
IP_AGENT_VIDEO_RENDER_SERVICE_FALLBACK_LOCAL=false
```

## HTTP 接口

- `GET /health`
- `POST /v1/assets/prepare`
- `PUT /v1/assets/{assetId}/content`
- `GET /v1/background-music`
- `POST /v1/background-music`（原始音频 body，带 `X-Background-Music-Name`）
- `DELETE /v1/background-music/{musicId}`
- `GET|HEAD /v1/background-music/{musicId}/content`
- `POST /v1/render-jobs`
- `GET /v1/render-jobs/{jobId}`
- `DELETE /v1/render-jobs/{jobId}`
- `GET|HEAD /v1/render-jobs/{jobId}/content`
- `GET|HEAD /v1/render-jobs/{jobId}/subtitles`

所有 `/v1` 请求都要带 `Authorization: Bearer ...` 和 `X-Render-Tenant: ...`。素材上传会校验声明的字节数和 SHA-256；成片下载支持 HTTP Range。

背景音乐存在服务级的 `runtime-data/background-music` 里，和租户/项目素材分开。渲染任务可以带 `backgroundMusicId` 和 `backgroundMusicVolume`（`0..1`）；只能用通过背景音乐接口上传过的曲子，且被排队中或运行中的任务引用时不能删除。

## 环境依赖

| 组件 | 用途 |
|---|---|
| FFmpeg / FFprobe | 剪辑、转场、字幕烧录、成片封装 |
| Python + faster-whisper | 语音转写（字幕时间轴） |
| opencc | 繁体转简体 |

> 注意：本服务用到 `-filter_complex` 内联滤镜图；`-filter_complex_script` 在 ffmpeg 9 里已被移除，早期版本代码用该参数，在 ffmpeg 8+ 上会报 `VIDEO_TRANSITION_FAILED`。
