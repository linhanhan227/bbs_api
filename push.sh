#!/bin/bash
# push.sh —— 一键提交并推送当前改动到远程仓库
#
# 用法：
#   bash push.sh "提交信息"    # 指定提交信息
#   bash push.sh               # 不带参数时交互式输入提交信息
#
# 行为：暂存全部改动(git add -A) -> 提交 -> 推送到远程的「当前分支」（普通推送，非强推）
# 注意：git add -A 会暂存包括本脚本在内的所有改动；若不想提交本脚本，请将其加入 .gitignore。

set -euo pipefail

# 1. 必须在 Git 仓库内
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "错误：当前目录不是 Git 仓库。" >&2
  exit 1
fi

# 2. 取当前分支名（推当前分支，避免写死 master 造成误推）
branch=$(git rev-parse --abbrev-ref HEAD)

# 3. 无改动则直接退出，避免空提交
if [ -z "$(git status --porcelain)" ]; then
  echo "没有检测到改动，无需提交。"
  exit 0
fi

echo "当前分支：$branch"
echo "=== 待提交的改动 ==="
git status --short

# 4. 提交信息：优先取第一个参数，否则交互式输入
commit_message="${1:-}"
if [ -z "$commit_message" ]; then
  read -rp "请输入提交信息：" commit_message
fi
# 拒绝纯空白的提交信息
if [ -z "${commit_message// /}" ]; then
  echo "错误：提交信息不能为空。" >&2
  exit 1
fi

# 5. 暂存并提交
git add -A
git commit -m "$commit_message"

# 6. 组装推送命令：分支尚无上游时用 -u 建立关联（首次推送）
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  push_cmd=(git push)
else
  echo "分支 $branch 尚未关联远程，首次推送将建立关联。"
  push_cmd=(git push -u origin "$branch")
fi

# 7. 推送（最多重试 3 次，应对偶发网络中断，如 Connection reset）
for attempt in 1 2 3; do
  if "${push_cmd[@]}"; then
    echo "=== 推送成功（$branch -> origin/$branch）==="
    exit 0
  fi
  if [ "$attempt" -lt 3 ]; then
    echo "第 $attempt 次推送失败，3 秒后重试..." >&2
    sleep 3
  fi
done

echo "错误：推送多次失败。请检查网络连接、远程权限，或确认远程是否有新提交需先 git pull --rebase。" >&2
exit 1
