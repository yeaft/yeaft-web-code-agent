---
name: review-merge-tag
description: 用 RepoWorkflow 在任意 GitHub 仓库执行开发 worktree、精确 PR review snapshot、head-match merge、数字 tag 与 workflow 验证；避免重复手工 git/gh 检查。
---

# Repository Workflow

不要逐条调用 `git fetch`、`git worktree list`、`gh pr view`、`git ls-remote` 和 `gh run watch` 来发现同一批事实。使用内置 `RepoWorkflow` 工具；非 Yeaft 环境使用等价的 `yeaft-repo` CLI。两者返回相同的紧凑 JSON。

## 三个边界

### 1. 开发准备

```json
{
  "phase": "prepare",
  "name": "fix-short-description"
}
```

它会在当前仓库中确定远端默认分支、拉取最新精确基线、检查 worktree/branch/path 冲突，并创建或安全复用 `yeaft-wt/<name>`。后续开发只使用返回的 `worktree.path`。

### 2. 独立 review 准备

Reviewer 调用：

```json
{
  "phase": "review-prep",
  "pr": 123
}
```

它会一次冻结 GitHub PR 的 base/head/merge snapshot、检查 draft/conflict/checks，并创建 detached exact-snapshot review worktree。Reviewer 必须审查返回的 `reviewWorktree.path`，并把明确结论、`pullRequest.headSha` 和 `pullRequest.snapshotSha` 交回开发者。

工具只冻结事实，不替代代码审查。

### 3. Review 通过后的落地

只有收到独立 reviewer 的明确批准后才能调用：

```json
{
  "phase": "land",
  "pr": 123,
  "reviewedHead": "<exact 40-char head SHA>",
  "reviewedSnapshot": "<exact 40-char merge snapshot SHA>",
  "approvedBy": "reviewer-id",
  "tagPrefix": "v1.0.",
  "workflow": "Dev Release",
  "worktreePaths": ["<development worktree>", "<review worktree>"]
}
```

`land` 不会推断 review 已通过。它会重新冻结 PR，任何 head/snapshot 漂移都会停止；随后使用 GitHub API 的 `sha` 做 head-match merge。若要求 tag，它只从远端 tags 数值计算下一版并精确推送；若要求 workflow，它等待匹配 tag 与 merge SHA 的 run 完成；最后只删除干净且明确指定的 worktree。

## 通用性与边界

- 适用于 Agent 可访问的任意本地 GitHub 仓库，不包含项目路径或固定 `main` 假设。
- 需要 `git` 和已认证的 `gh` CLI；不依赖 Python，也不通过 shell 拼接命令。
- 当前不支持 GitLab/Bitbucket；不要把 GitHub 成功误报为 forge-agnostic。
- 自动化只消除重复事实核对，不消除独立 review、测试选择、代码判断或用户授权。
- `land` 后若 workflow 失败，merge/tag 可能已经完成；读取错误 JSON 的 `details.remoteEffects`，不要盲目重试或重打 tag。

## CLI

Yeaft 外部或人工终端可运行：

```bash
yeaft-repo prepare --name fix-short-description
yeaft-repo review-prep --pr 123
yeaft-repo land --pr 123 \
  --reviewed-head <sha> \
  --reviewed-snapshot <sha> \
  --approved-by reviewer-id \
  --tag-prefix v1.0. \
  --workflow "Dev Release"
```

每条命令 stdout 只输出一个成功 JSON；失败时 stderr 输出一个带稳定 `code` 和副作用状态的 JSON。
