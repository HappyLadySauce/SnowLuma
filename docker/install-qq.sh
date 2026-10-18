#!/usr/bin/env bash
# 构建期安装 NTQQ（Linux 版 QQ 桌面客户端）。
# 用法: install-qq.sh <amd64|arm64>
# 流程: 官方下载配置 JSON 取最新版 deb 直链 -> 调官方签名接口换签名 URL
#       （release 路径有防盗链，未签名会 403）-> 下载 -> dpkg 安装。
set -euo pipefail

DEB_ARCH="${1:?usage: install-qq.sh <amd64|arm64>}"
CONFIG_URL="https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json"
SIGN_API="https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign"
SIGN_HEADER='{"uint32_command":"0x9b8e","uint32_service_type":1}'
DEB_PATH="/tmp/qq-installer.deb"

command -v curl >/dev/null || { echo "curl is required" >&2; exit 127; }
command -v node >/dev/null || { echo "node is required" >&2; exit 127; }

# 从官方配置解析最新版 deb 直链（amd64/x64DownloadUrl.deb, arm64/armDownloadUrl.deb）
RAW_URL=$(node -e '
  const arch = process.argv[1] === "arm64" ? "armDownloadUrl" : "x64DownloadUrl";
  fetch(process.argv[2], { headers: { "User-Agent": "Mozilla/5.0" } })
    .then((r) => { if (!r.ok) throw new Error(`config HTTP ${r.status}`); return r.json(); })
    .then((c) => {
      const url = c?.Linux?.[arch]?.deb;
      if (!url) throw new Error("no deb url in config");
      process.stdout.write(url);
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
' "$DEB_ARCH" "$CONFIG_URL")
echo "[install-qq] latest NTQQ deb: $RAW_URL"

# 优先使用签名 URL；签名失败则回退原始 URL（部分路径本就无需签名）
SIGNED_URL=$(node -e '
  const [raw, api, header] = process.argv.slice(1);
  fetch(api, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-oidb": header },
    body: JSON.stringify({ url: raw }),
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`sign HTTP ${r.status}`))))
    .then((j) => {
      const url = j?.data?.url;
      process.stdout.write(typeof url === "string" && url ? url : "");
    })
    .catch(() => process.stdout.write(""));
' "$RAW_URL" "$SIGN_API" "$SIGN_HEADER" || true)
DOWNLOAD_URL="${SIGNED_URL:-$RAW_URL}"
if [ -n "$SIGNED_URL" ]; then
  echo "[install-qq] using signed download url"
else
  echo "[install-qq] sign api unavailable, falling back to raw url"
fi

curl --retry 3 --connect-timeout 30 --max-time 900 -fL \
  -A "Mozilla/5.0" -H "Referer: https://im.qq.com/linuxqq/" \
  -o "$DEB_PATH" "$DOWNLOAD_URL"

dpkg -i "$DEB_PATH" || { apt-get update && apt-get -f install -y; dpkg -i "$DEB_PATH"; }
rm -f "$DEB_PATH"

echo "[install-qq] installed: $(cat /opt/QQ/resources/app/package.json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("unknown")}})' 2>/dev/null || echo unknown) at /opt/QQ"
