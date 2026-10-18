# syntax=docker/dockerfile:1
# SnowLuma + NTQQ（无头）一体化镜像
#   - 构建阶段: 本地源码编译 SnowLuma（含 WebUI 与原生注入件）
#   - 运行阶段: node:22-bookworm-slim + Xvfb + 最新版 NTQQ（构建时从官方源自动下载）
# 构建: docker build -t snowluma-ntqq -f docker/Dockerfile .

ARG NODE_VERSION=22

# 网络受限环境可覆盖，例如国内:
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
#   --build-arg APT_MIRROR=mirrors.ustc.edu.cn
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG APT_MIRROR=deb.debian.org

# ─────────────────────────── 阶段 1: 编译 SnowLuma ───────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS build

ARG NPM_REGISTRY
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_NPM_REGISTRY=${NPM_REGISTRY} \
    npm_config_registry=${NPM_REGISTRY} \
    CI=1

# packageManager 字段锁定 pnpm@10.28.0，corepack 按声明自动启用
RUN corepack enable

WORKDIR /src

# 先复制清单以利用层缓存（package.json 变动才重新安装依赖）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/bridge/package.json packages/bridge/package.json
COPY packages/common/package.json packages/common/package.json
COPY packages/onebot/package.json packages/onebot/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/proto-defs/package.json packages/proto-defs/package.json
COPY packages/proton/package.json packages/proton/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/websocket/package.json packages/websocket/package.json
COPY packages/webui/package.json packages/webui/package.json
COPY packages/ui/package.json packages/ui/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# 复制完整源码并构建:
#   core build:all  -> dist/index.mjs + dist/native/*.node + launcher + EULA/PRIVACY
#   webui build     -> dist/client（WebUI 静态资源，core 经 Hono serve）
COPY . .

# 二次安装让各包 prepare 脚本（如 proton 预构建）在源码就绪后执行
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile && \
    pnpm --filter @snowluma/core build:all && \
    pnpm --filter webui build && \
    node tools/check-release-layout.mjs dist

# ─────────────────────────── 阶段 2: 运行时 ───────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG TARGETARCH
ARG APT_MIRROR
ENV DEBIAN_FRONTEND=noninteractive

# 可选: 切换 Debian 镜像源（受限网络环境）
RUN if [ -n "${APT_MIRROR}" ] && [ "${APT_MIRROR}" != "deb.debian.org" ]; then \
      sed -ri "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi

# QQ(Electron) 无头运行所需的最小共享库集合 + Xvfb 虚拟显示 + 中文字体
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl ca-certificates tzdata \
      xvfb x11vnc novnc websockify \
      x11-apps netpbm \
      libnss3 libnspr4 \
      libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
      libcups2 libdrm2 libgbm1 libxkbcommon0 \
      libx11-6 libx11-xcb1 libxcb1 libxext6 libxi6 libxtst6 libxss1 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libpango-1.0-0 libcairo2 libgtk-3-0 \
      libasound2 libnotify4 libsecret-1-0 libdbus-1-3 \
      fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /tmp/* /var/tmp/*

# 构建期自动下载安装最新版 NTQQ（x86_64/arm64）
COPY docker/install-qq.sh /tmp/install-qq.sh
RUN DEB_ARCH=$([ "${TARGETARCH}" = "arm64" ] && echo arm64 || echo amd64) && \
    bash /tmp/install-qq.sh "${DEB_ARCH}" && \
    rm -f /tmp/install-qq.sh

# SnowLuma 产物（含 native 注入件，运行时经 __dirname/native 解析，无需 node_modules）
COPY --from=build /src/dist /app/dist
COPY docker/entrypoint.sh /app/entrypoint.sh

RUN mkdir -p /app/data /home/node/.config/QQ && \
    chown -R node:node /app /home/node && \
    chmod +x /app/entrypoint.sh

# 注意: 容器以 root 启动，由 entrypoint.sh 完成 chown 后
# 通过 setpriv 降权为 node 用户并保留 CAP_SYS_PTRACE（ambient），
# 满足 ptrace 注入对同用户 + 能力的要求

# 运行期数据目录（config/ logs/ 及账号数据均落在 cwd）与 QQ 登录数据
VOLUME ["/app/data", "/home/node/.config/QQ"]

ENV SNOWLUMA_WEBUI_HOST=0.0.0.0 \
    SNOWLUMA_HOOK_AUTOLOAD=1 \
    HOME=/home/node \
    DISPLAY=:99 \
    TZ=Asia/Shanghai

WORKDIR /app/data

# 入口以 root 起步修好卷属主后降权为 node（见 entrypoint.sh）
ENTRYPOINT ["/bin/bash", "/app/entrypoint.sh"]
