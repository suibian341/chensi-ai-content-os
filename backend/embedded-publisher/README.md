# 内置平台发布模块

该目录内的 `Core/` 与 `uploader/` 源码来自用户提供的
`third-party-platform-auto-publish(1).md` 源码附录，运行模式已经从独立 HTTP 服务改为
由当前 Node 后端调用 `bridge.py`。

运行依赖：

```powershell
python -m pip install -r backend/embedded-publisher/requirements.txt
```

扫码登录会打开本机 Chrome 或 Edge。登录态保存在
`backend/data/publishing-sessions/`，按 Web 用户隔离，不应提交到版本库或发送给他人。
