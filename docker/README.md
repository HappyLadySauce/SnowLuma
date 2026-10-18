# SnowLuma + NTQQ（无头）Docker 部署

单容器运行无头 Linux QQ（NTQQ）+ SnowLuma 协议桥接，对外提供 WebUI 与 OneBot v11 服务。
QQ 以 Xvfb 虚拟显示无头运行，SnowLuma 启动后自动发现并注入 QQ 进程（`pipe connected` 即成功）。

## 构建与启动

```bash
cd docker
docker compose up -d --build
```

普通网络环境请删除 `docker-compose.yml` 中 `build.args` 的两行镜像源参数与 `network: host` 行，
使用默认 npmjs / deb.debian.org 源即可。

单独构建镜像：

```bash
docker build -t snowluma-ntqq -f docker/Dockerfile ..
# 受限网络环境附加:
#   --network host
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
#   --build-arg APT_MIRROR=mirrors.ustc.edu.cn
```

## 首次使用

1. 打开 `http://<主机>:5099` 进入 WebUI。
2. 初始密码从容器日志获取（每次未改密前启动都会重新生成）:

   ```bash
   docker logs snowluma | grep 'initial credentials'
   ```

   或在 compose 的 `environment` 中设置 `SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD`（≥8 位）固定初始密码。
3. **首次登录 QQ（扫码）**: 打开 WebUI 侧边栏的「QQ 登录」页，页面实时显示容器内 QQ 登录窗口
   （含二维码，约 2 秒自动刷新），用手机 QQ 扫码确认即可。二维码过期可点「重启登录窗口」。
4. **多账号（屏幕隔离）**: 「QQ 登录」页点「新增 QQ 进程」会启动一个完全隔离的 QQ 实例——
   独立数据目录（`/app/data/qq-instances/instance-N`，随卷持久化）+ **独立虚拟屏幕**
   （显示器 :100 起逐个分配），SnowLuma 自动发现并注入，每个实例各自扫码登录。
   **点击实例卡片即可切换实时画面到该实例的屏幕**；卡片上的外部链接图标是该实例专属的
   noVNC 入口（端口 5902 起，密码登录兜底）。实例按钮：**刷新**（重新触发注入刷新）与
   **删除**（仅隔离实例：终止进程、回收其屏幕并清除登录数据，不可恢复）；
   默认实例由容器托管（屏幕 :99 / noVNC 5901），只能用「重启登录窗口」重置。
5. 登录成功后（WebUI「进程注入」页该进程显示在线）在 WebUI 中配置 OneBot WebSocket/HTTP 连接。
6. 容器使用 `network_mode: host` 共享宿主机网络栈（保证 QQ 可出网）：WebUI 5099、noVNC 5901
   直接在宿主机监听，无需端口映射；OneBot 在 WebUI 中配置的端口同样直接生效。

## 运行机制与权限

- SnowLuma 通过 ptrace 类原生注入接入 QQ，因此：
  - `cap_add: [SYS_PTRACE]` + `security_opt: [seccomp:unconfined]`（compose 已配置）；
  - 宿主 Yama `ptrace_scope=1` 时兄弟进程注入需要 CAP_SYS_PTRACE，entrypoint 用
    `setpriv --ambient-caps=+sys_ptrace` 降权时保留该能力；
  - QQ 与 SnowLuma 必须同用户（容器内统一为 uid 1000 的 `node`）。
- QQ 崩溃由 entrypoint 自动拉起；SnowLuma 退出则容器退出，交给 `restart: unless-stopped` 重启。

## 数据卷

| 卷 | 容器路径 | 内容 |
| --- | --- | --- |
| `snowluma-data` | `/app/data` | SnowLuma 配置（config/）、日志（logs/）、账号数据 |
| `qq-data` | `/home/node/.config/QQ` | QQ 登录态与本地数据 |

## 环境变量（常用）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SNOWLUMA_WEBUI_PORT` | 5099 | WebUI 端口 |
| `SNOWLUMA_WEBUI_HOST` | 0.0.0.0（镜像内置） | WebUI 绑定地址 |
| `SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD` | 随机 | 初始登录密码（≥8 位） |
| `SNOWLUMA_ACCEPT_EULA` / `SNOWLUMA_ACCEPT_PRIVACY` | 1（compose 内置） | 视为已同意 EULA / 隐私政策 |
| `QQ_ARGS` | 空 | 附加传给 QQ 的命令行参数 |
| `XVFB_SCREEN` | 1280x720x24 | 虚拟显示分辨率 |

## NTQQ 版本

镜像构建时从 QQ 官方配置接口（`im.qq.com` 下载页配置 JSON + 官方签名接口）自动获取
**最新版** Linux QQ deb 安装，脚本见 `docker/install-qq.sh`；QQ 升级后重新 build 镜像即可。
