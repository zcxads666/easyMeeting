# 项目约定

## Git 提交规则

涉及非日常活动的任务，只要作用于项目代码变动/更改，**每完成一个任务就执行一次 git 提交**：

1. `git status` 检查本次任务产生的改动
2. `git add` 仅暂存本任务相关文件（不夹带无关改动）
3. `git commit`，使用 Conventional Commits 风格（feat/fix/refactor/docs/test/chore），中文描述任务内容
4. 仓库已配置远程且改动需要同步时，执行 `git push`

规则不适用于：纯咨询问答、未产生代码变更的阅读分析、用户明确表示暂不提交的情况。
