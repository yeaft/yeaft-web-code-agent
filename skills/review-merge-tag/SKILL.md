---
name: review-merge-tag
description: PR 复审通过后的自动收尾流程。确认 review 无阻塞后，通过 gh pr merge 合并到 main，从 main 生成并推送下一个 v0.1.X tag，然后清理对应 worktree。
---

# Review Merge Tag

把“PR 已开发完成并复审通过”之后的收尾动作固化为可重复流程：合并 PR、从 `main` 打下一个 `v0.1.X` tag、推送 tag、清理 worktree。

## 输入

- `pr`：PR number 或 PR URL，必填。
- `worktreePath`：对应开发 worktree 路径，可选；提供后用于最后 `ExitWorktree` 清理。
- `branch`：PR head branch，可选；用于核对和清理说明。
- `tagPrefix`：tag 前缀，可选，默认 `v0.1.`。
- `reviewPassedContext`：复审通过上下文，可选；当自动检查不到 Martin 审计 comment 时必须提供。
- `releaseTag`：是否额外打 `release-v0.1.X`，默认 `false`；只有用户明确要求发布触发 tag 时才允许。

## 不可违反的安全规则

- 只允许通过 `gh pr merge` 合并；禁止 `git push origin HEAD:main` 或 `git push origin <branch>:main`。
- 只允许在主 checkout 的 `main` 上打 tag；禁止在 feature/worktree 分支打 tag。
- PR 未明确 review 通过时禁止 merge。
- 禁止清理无关 `.yeaft/...` 运行时数据。
- 遇到冲突、CI 失败、review 未确认、tag 已存在但 commit 不匹配、`main` 与 `origin/main` 不一致时，立即停止并报告。

## 流程

### Step 1: 解析 PR

从 PR URL 或文本中提取 PR number。

```bash
source ~/.zshrc && gh pr view <pr> --json number,url,state,isDraft,baseRefName,headRefName,mergeStateStatus,reviewDecision,statusCheckRollup,comments,mergeCommit
```

必须满足：

- PR 存在。
- `baseRefName` 是 `main`。
- `isDraft` 是 `false`。
- `state` 是 `OPEN` 或 `MERGED`。
- `mergeStateStatus` 不是明显冲突状态。
- `reviewDecision` 是 `APPROVED`，或 comments / 调用上下文里明确有 Martin 复审通过、无阻塞问题。
- status checks 不能有 failure/error/cancelled；如果 GitHub 没有 checks，也要在输出中说明“未发现 CI checks，依赖本地测试和 review 上下文”。

如果无法自动确认 review 通过，停止，要求调用者提供 `reviewPassedContext`。不要猜。

### Step 2: 合并 PR

如果 PR 已经是 `MERGED`，跳过 merge，但必须继续确认 merge commit 已进入 `origin/main`。

否则执行：

```bash
source ~/.zshrc && gh pr merge <pr> --merge --delete-branch
```

允许的非致命情况：

- `already merged`：继续后续确认。
- 本地分支因 worktree checkout 无法删除：这是预期；最后用 `ExitWorktree` 清理。

其他错误停止。

### Step 3: 同步 main checkout

固定使用项目主 checkout：

```bash
cd /home/azureuser/projects/claude-web-chat && git switch main && git pull --ff-only
```

确认：

```bash
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
git merge-base --is-ancestor <mergeCommitOrHead> origin/main
```

必须满足：

- 当前分支是 `main`。
- `HEAD == origin/main`。
- PR merge commit 可从 `origin/main` 到达。

不满足就停止；不要在错误 commit 上打 tag。

### Step 4: 计算下一个 tag

不要用创建时间排序。按数值解析现有 `v0.1.X`：

```bash
git tag --list 'v0.1.*'
```

选择最大的数字后缀 `X`，下一个 tag 是 `v0.1.<X+1>`。如果传了 `tagPrefix`，只在完全理解其格式时使用；否则停止确认。

创建前检查：

```bash
git rev-parse -q --verify refs/tags/<nextTag>
```

- 如果 tag 不存在：继续。
- 如果 tag 已存在且指向当前 `HEAD`：说明已打过，输出即可。
- 如果 tag 已存在但不是当前 `HEAD`：停止；这是危险状态。

### Step 5: 打 tag 并推送

```bash
git tag <nextTag>
git push origin <nextTag>
```

默认不要打 `release-v0.1.X`。只有 `releaseTag: true` 且用户明确要求时才允许：

```bash
git tag release-<nextTag>
git push origin release-<nextTag>
```

### Step 6: 清理 worktree

如果提供了 `worktreePath`，使用工具清理，不要手动 `rm -rf`：

```text
ExitWorktree(path: worktreePath, action: "remove", discard_changes: true)
```

说明：PR 已通过 merge 进入 `main` 后，worktree 内的已提交变更可以 discard。不要清理主 checkout 里的 `.yeaft/...` 运行时数据。

### Step 7: 精简输出

默认只输出这些字段：

- PR：`#<number>` / URL
- Merge commit：`<sha>`
- Tag：`<nextTag>`
- Worktree cleanup：已清理 / 未提供 / 跳过原因
- Notes：只列必要异常，比如“CI checks 不存在”或“PR 已提前 merged”

不要输出长篇 report。只有用户明确要求 `detail` / `report` 时，才补充完整命令日志和检查细节。

## 停止条件

遇到以下任一情况必须停下：

- PR 不存在、draft、base 不是 `main`。
- PR 未 review 通过，且调用上下文没有明确“Martin 复审通过 / 无阻塞问题”。
- merge state 显示冲突或不可合并。
- 任一 CI/status check 失败、报错或取消。
- `git pull --ff-only` 失败。
- 当前分支不是 `main`，或 `HEAD != origin/main`。
- PR merge commit 不可从 `origin/main` 到达。
- 下一个 tag 已存在但不指向当前 `HEAD`。
- 用户要求打 release tag 但没有明确授权。

## 示例输出

```text
完成。
- PR: #970 https://github.com/yeaft/claude-web-chat/pull/970
- Merge commit: e082f3a42b3740873b5ade1558d7d52171badc06
- Tag: v0.1.959
- Worktree cleanup: removed .yeaft/worktrees/fix-prompt-language-concise
```
