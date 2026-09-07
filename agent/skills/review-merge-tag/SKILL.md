---
name: review-merge-tag
description: 用 RepoWorkflow 在任意 GitHub 仓库执行开发 worktree、精确 PR review snapshot、base-ref CAS landing、数字 tag 与 workflow 验证；避免重复手工 git/gh 检查。
---

# Repository Workflow

不要逐条调用 `git fetch`、`git worktree list`、`gh pr view`、`git ls-remote` 和 `gh run watch` 来发现同一批事实。Session 内使用 `RepoWorkflow` 工具。非 Yeaft 环境可用 `yeaft-repo` CLI 执行 `prepare` 和 `review-prep`，这两个阶段返回与工具相同的紧凑 JSON；CLI 不能执行 `land`。

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

它会一次冻结 GitHub PR 的 base branch/base SHA/head/merge snapshot、检查 draft/conflict/checks，并创建 detached exact-snapshot review worktree。Reviewer 必须审查返回的 `reviewWorktree.path`，并把明确结论、`pullRequest.baseBranch`、`pullRequest.baseSha`、`pullRequest.headSha` 和 `pullRequest.snapshotSha` 交回开发者。

工具只冻结事实，不替代代码审查。

### 3. Review 通过后的落地

只有收到独立 reviewer 的明确批准后才能调用。Reviewer 必须用 `RouteForward` 把绑定仓库、PR、exact base branch/base SHA/head/merge snapshot 的结构化批准交回 landing VP；宿主会随该 handoff 铸造不可序列化、一次性的 approval capability。随后 landing VP 才能在处理该 handoff 的同一 turn 调用：

```json
{
  "phase": "land",
  "pr": 123,
  "baseBranch": "main",
  "baseSha": "<exact 40-char base SHA>",
  "reviewedHead": "<exact 40-char head SHA>",
  "reviewedSnapshot": "<exact 40-char merge snapshot SHA>",
  "tagPrefix": "v1.0.",
  "workflow": "Dev Release"
}
```

`approvedBy` 等普通字符串没有授权语义。`land` 只接受宿主 capability，并重新冻结 PR；任何 repo、PR、recipient、base branch、base SHA、head 或 snapshot 不匹配都会停止。Reviewed snapshot 必须以批准的 base SHA/head 为两个父提交；landing 的目标 ref 只从批准的 base branch 推导，并在任何写入前拒绝 PR retarget。之后它通过单次 receive-pack 更新，用 `--force-with-lease=<base-ref>:<approved-base>` 将该 exact snapshot 安装到批准的远端 base。若 base 在最后冻结与 receive 之间前进，lease 会拒绝更新，并且不会创建 tag。若要求 tag，它只在 base CAS 成功后从远端 tags 数值计算下一版，用 create-only lease 推送并复核 base 与 tag。若要求 workflow，它等待匹配 tag 与 reviewed snapshot SHA 的 run 完成。

Worktree cleanup 不属于 landing。`land` 会在任何仓库或远端副作用前拒绝 cleanup 请求，包括 active `repoRoot`；需要 cleanup 时必须在 landing 完成后走独立操作，cleanup 失败不能改变 landing 结果。

## 通用性与边界

- 适用于 Agent 可访问的任意本地 GitHub 仓库，不包含项目路径或固定 `main` 假设。
- 需要 `git` 和已认证的 `gh` CLI；不依赖 Python，也不通过 shell 拼接命令。
- 当前不支持 GitLab/Bitbucket；不要把 GitHub 成功误报为 forge-agnostic。
- 自动化只消除重复事实核对，不消除独立 review、测试选择、代码判断或用户授权。
- `land` 后若 workflow 失败，merge/tag 可能已经完成；读取错误 JSON 的 `details.remoteEffects`，不要盲目重试或重打 tag。

## CLI

Yeaft 外部或人工终端只可运行准备阶段：

```bash
yeaft-repo prepare --name fix-short-description
yeaft-repo review-prep --pr 123
```

独立 CLI 不能执行 `land`。Landing 必须在 Session 中通过 `RepoWorkflow` 工具执行，并携带当前 handoff 由宿主签发、绑定 exact review 的 approval capability；普通参数或 `approvedBy` 字符串不能替代该 capability。

每条可用命令 stdout 只输出一个成功 JSON；失败时 stderr 输出一个带稳定 `code` 和副作用状态的 JSON。
