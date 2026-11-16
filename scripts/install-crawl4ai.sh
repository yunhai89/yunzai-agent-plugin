#!/bin/sh
# install-crawl4ai.sh
# ----------------------------------------------------------------------------
# 安装 crawl4ai 抓取运行时（独立 venv + Playwright Chromium），供
# model/crawl/crawl4ai.js 以子进程方式调用（网页内容获取默认引擎，未装自动降级 fetch）。
#
# 做什么：
#   [1/6] 检查 python3（>=3.10）
#   [2/6] 创建独立 venv（默认 <插件>/.crawl4ai-venv；CRAWL4AI_VENV 覆盖——容器场景可挂卷）
#   [3/6] venv pip 安装 crawl4ai（支持 PIP_INDEX_URL / PIP_EXTRA_ARGS 镜像与加速）
#   [4/6] 安装 Playwright Chromium 到插件目录（默认 <插件>/.crawl4ai-browsers；
#         PLAYWRIGHT_BROWSERS_PATH / CRAWL4AI_BROWSERS_DIR 可覆盖）
#   [5/6] 验证 import + 版本
#   [6/6] Chromium 启动冒烟；SMOKE_URL 非空时再跑一次真实抓取
#
# 用法：
#   sh plugins/agents-plugin/scripts/install-crawl4ai.sh
#   # 只补浏览器（插件启动时自动安装也走这个模式）：
#   CRAWL4AI_BROWSER_ONLY=1 sh scripts/install-crawl4ai.sh
# 常用覆盖：
#   PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple sh scripts/install-crawl4ai.sh
#   PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright sh scripts/install-crawl4ai.sh
#   CRAWL4AI_VENV=/data/crawl4ai-venv sh scripts/install-crawl4ai.sh   # 容器重建不丢
#   CRAWL4AI_BROWSERS_DIR=/data/ms-playwright sh scripts/install-crawl4ai.sh
#   SMOKE_URL=https://example.com sh scripts/install-crawl4ai.sh       # 额外真实抓取冒烟
# ----------------------------------------------------------------------------

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
VENV_DIR="${CRAWL4AI_VENV:-$PLUGIN_ROOT/.crawl4ai-venv}"
BROWSER_ONLY="${CRAWL4AI_BROWSER_ONLY:-0}"
if [ "$BROWSER_ONLY" = "1" ] && [ ! -x "$VENV_DIR/bin/python3" ]; then
  echo "    补装模式但 venv 不存在，改为完整安装"
  BROWSER_ONLY=0
fi

# 浏览器默认装到插件目录，不再散落到 ~/.cache/ms-playwright；用户显式设置时优先尊重。
if [ -z "$PLAYWRIGHT_BROWSERS_PATH" ]; then
  PLAYWRIGHT_BROWSERS_PATH="${CRAWL4AI_BROWSERS_DIR:-$PLUGIN_ROOT/.crawl4ai-browsers}"
  export PLAYWRIGHT_BROWSERS_PATH
fi
echo "    浏览器目录：$PLAYWRIGHT_BROWSERS_PATH"

echo "[1/6] 检查 python3"
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "错误：未找到 python3（crawl4ai 需要 Python >= 3.10）。请先安装：apt install python3 python3-venv python3-pip" >&2
  exit 1
fi
PYVER="$("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
echo "    python3 = $PY ($PYVER)"
"$PY" -c 'import sys; sys.exit(0 if (sys.version_info[0], sys.version_info[1]) >= (3, 10) else 1)' || {
  echo "错误：Python $PYVER < 3.10，crawl4ai 需要 >= 3.10" >&2
  exit 1
}

echo "[2/6] 创建/检查 venv：$VENV_DIR"
if [ "$BROWSER_ONLY" = "1" ] && [ -x "$VENV_DIR/bin/python3" ]; then
  echo "    补装模式：复用已有 venv，跳过重新创建"
else
  "$PY" -m venv "$VENV_DIR" 2>/dev/null || {
    echo "错误：venv 创建失败（缺 python3-venv？Debian/Ubuntu：apt install python3-venv）" >&2
    exit 1
  }
fi
VENV_PY="$VENV_DIR/bin/python3"
if [ ! -x "$VENV_PY" ]; then
  echo "错误：venv 内没有 python3：$VENV_PY" >&2
  exit 1
fi
if [ "$BROWSER_ONLY" = "1" ] && ! "$VENV_PY" -c 'import crawl4ai' >/dev/null 2>&1; then
  echo "    补装模式但 crawl4ai 包不可用，改为完整安装"
  BROWSER_ONLY=0
fi

if [ "$BROWSER_ONLY" = "1" ]; then
  echo "[3/6] 补装模式：跳过 pip 安装 crawl4ai（只补 Chromium）"
else
  "$VENV_PY" -m pip install --upgrade pip >/dev/null 2>&1 || echo "    （pip 升级跳过，继续）"
  echo "[3/6] 安装 crawl4ai（可用 PIP_INDEX_URL 走镜像）"
  if [ -n "$PIP_INDEX_URL" ]; then echo "    使用镜像：$PIP_INDEX_URL"; fi
  "$VENV_PY" -m pip install --upgrade crawl4ai ${PIP_EXTRA_ARGS:-}
fi

echo "[4/6] 安装 Playwright Chromium（$PLAYWRIGHT_BROWSERS_PATH）"
browser_ok() {
  "$VENV_PY" - <<'PY' >/dev/null 2>&1
import os
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    path = p.chromium.executable_path
raise SystemExit(0 if path and os.path.isfile(path) else 1)
PY
}
if browser_ok; then
  echo "    Chromium 已存在，跳过下载"
else
  # Chromium ~184MB 走 cdn.playwright.dev，国内/受限网络常停滞——失败自动用 npmmirror 镜像重试一次
  install_browser() {
    if "$VENV_PY" -m crawl4ai.setup >/dev/null 2>&1; then return 0; fi
    if command -v "$VENV_DIR/bin/crawl4ai-setup" >/dev/null 2>&1 && "$VENV_DIR/bin/crawl4ai-setup"; then return 0; fi
    "$VENV_PY" -m playwright install chromium
  }
  if ! install_browser; then
    echo "    默认源失败，改用 npmmirror 镜像重试 Chromium 下载…"
    PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST:-https://cdn.npmmirror.com/binaries/playwright}" \
      "$VENV_PY" -m playwright install chromium || {
      echo "错误：Chromium 安装失败。手动重试：PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright $VENV_PY -m playwright install chromium" >&2
      exit 1
    }
  fi
  browser_ok || {
    echo "错误：Chromium 已下载但不可用（缺系统库？Debian/Ubuntu 可试：$VENV_PY -m playwright install-deps chromium）" >&2
    exit 1
  }
fi

echo "[5/6] 验证 import + 版本"
C4AI_VER="$("$VENV_PY" -c 'from importlib.metadata import version; print(version("crawl4ai"))')"
echo "    crawl4ai $C4AI_VER @ $VENV_DIR"

echo "[6/6] Chromium 启动冒烟"
if [ "${SKIP_VERIFY:-0}" = "1" ]; then
  echo "    已跳过（SKIP_VERIFY=1）"
else
  "$VENV_PY" - <<'PY'
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    browser.close()
print("    Chromium 启动通过")
PY
  if [ -n "${SMOKE_URL:-}" ]; then
    echo "    额外真实抓取：$SMOKE_URL"
    echo "{\"url\": \"$SMOKE_URL\", \"timeout_s\": 45, \"max_chars\": 2000}" \
      | "$VENV_PY" "$PLUGIN_ROOT/python/crawl4ai_fetch.py" >/dev/null || {
      echo "    真实抓取冒烟失败（exit=$?）——浏览器已就绪，但目标网络/反爬可能失败；运行时仍会自动降级 fetch。" >&2
      exit 1
    }
    echo "    真实抓取通过"
  fi
fi

echo "完成。web_crawl / 知识库 URL 入库将默认走 crawl4ai（真浏览器渲染），失败自动降级 fetch。"
echo "浏览器目录：$PLAYWRIGHT_BROWSERS_PATH"
echo "如需强制纯 HTTP：config.yaml → agent.kb.crawl.engine: fetch"
