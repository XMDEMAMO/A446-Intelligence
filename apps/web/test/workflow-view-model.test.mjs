import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sourcePath = path.resolve(__dirname, '../src/workflow-view-model.ts')
const sourceCode = fs.readFileSync(sourcePath, 'utf8')

const transpiled = ts.transpileModule(sourceCode, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText

const {
  formatAgentDisplayName,
  formatModelDisplayName,
  resolveTaskModelInfo,
  buildWorkflowGraph,
  deriveIssues,
  deriveWorkflowSummary,
} = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)

// 从真实 LAN Hub 工作流裁剪出的最小稳定样本。测试不依赖某台机器的运行目录。
const fixtureAgents = [
  { agentId: 'win-codex', deviceId: 'win-host', account: { provider: 'openai' }, adapter: 'codex' },
  { agentId: 'win-google', deviceId: 'win-host', account: { provider: 'google' }, adapter: 'antigravity' },
  { agentId: 'device-google', deviceId: 'device-laptop', account: { provider: 'google' }, adapter: 'antigravity' },
]
const sample1Tasks = [
  {
    taskId: 'sample1-plan', rootTaskId: 'sample1-plan', targetAgentId: 'win-codex',
    role: 'planner', stage: 'planning', status: 'completed', createdAt: '2026-09-23T07:38:16Z',
    completedAt: '2026-09-23T07:42:09Z', input: '双 Google 账号并发验收',
    taskSpec: { title: '双 Google 账号并发与批次汇合真实验收' },
    model: 'gpt-6-sol', execution: { model: 'gpt-6-sol', reasoningEffort: 'high' },
  },
  {
    taskId: 'sample1-host', rootTaskId: 'sample1-plan', parentTaskId: 'sample1-plan',
    targetAgentId: 'win-google', role: 'executor', stage: 'execution', status: 'completed',
    workUnitId: 'sample1-unit-host', revision: 1, createdAt: '2026-09-23T07:38:53Z',
    input: '多 Agent 并发风险检查表', taskSpec: { title: '多 Agent 并发风险检查表' },
    model: 'gemini-3.8-flash-high',
  },
  {
    taskId: 'sample1-laptop-v1', rootTaskId: 'sample1-plan', parentTaskId: 'sample1-plan',
    targetAgentId: 'device-google', role: 'executor', stage: 'execution', status: 'completed',
    workUnitId: 'sample1-unit-laptop', revision: 1, superseded: true,
    supersededBy: 'sample1-laptop-v2', createdAt: '2026-09-23T07:38:54Z',
    input: '人工介入验收用例', taskSpec: { title: '人工精细介入验收用例' },
    model: 'gemini-3.8-flash-high',
  },
  {
    taskId: 'sample1-review-rejected', rootTaskId: 'sample1-plan', parentTaskId: 'sample1-laptop-v1',
    targetAgentId: 'win-codex', role: 'reviewer', stage: 'result_review', status: 'completed',
    createdAt: '2026-09-23T07:39:26Z', input: '审核首稿', model: 'gpt-6-sol',
    submission: { verdict: 'rejected', issues: ['越过只读边界', '涉及凭据操作', '人工动作与自动审核冲突'] },
  },
  {
    taskId: 'sample1-review-host', rootTaskId: 'sample1-plan', parentTaskId: 'sample1-host',
    targetAgentId: 'win-codex', role: 'reviewer', stage: 'result_review', status: 'completed',
    createdAt: '2026-09-23T07:39:44Z', input: '审核主机分支', model: 'gpt-6-sol',
    submission: { verdict: 'approved' },
  },
  {
    taskId: 'sample1-laptop-v2', rootTaskId: 'sample1-plan', parentTaskId: 'sample1-review-rejected',
    targetAgentId: 'device-google', role: 'executor', stage: 'revision', status: 'completed',
    workUnitId: 'sample1-unit-laptop', revision: 2, createdAt: '2026-09-23T07:40:12Z',
    input: '根据审核意见修订', taskSpec: { title: '人工精细介入验收用例' },
    model: 'gemini-3.8-flash-high',
  },
  {
    taskId: 'sample1-review-approved', rootTaskId: 'sample1-plan', parentTaskId: 'sample1-laptop-v2',
    targetAgentId: 'win-codex', role: 'reviewer', stage: 'result_review', status: 'completed',
    createdAt: '2026-09-23T07:40:30Z', input: '审核修订稿', model: 'gpt-6-sol',
    submission: { verdict: 'approved' },
  },
  {
    taskId: 'sample1-intake', rootTaskId: 'sample1-plan', parentTaskId: 'sample1-review-approved',
    targetAgentId: 'win-codex', role: 'planner', stage: 'result_intake', status: 'completed',
    createdAt: '2026-09-23T07:41:31Z', completedAt: '2026-09-23T07:42:09Z',
    input: '接收审核结果', model: 'gpt-6-sol', execution: { model: 'gpt-6-sol', reasoningEffort: 'high' },
    submission: { decision: 'complete', needsHuman: false },
    contextBundle: { approvedResults: [{ workUnitId: 'sample1-unit-host' }, { workUnitId: 'sample1-unit-laptop' }] },
  },
]
const sample2Tasks = [
  {
    taskId: 'sample2-plan', rootTaskId: 'sample2-plan', targetAgentId: 'win-codex',
    role: 'planner', stage: 'planning', status: 'completed', createdAt: '2026-09-23T07:49:12Z',
    completedAt: '2026-09-23T07:51:13Z', input: 'Reviewer Sol 默认策略真实验收',
    taskSpec: { title: 'Reviewer Sol 默认策略真实验收' }, model: 'gpt-6-sol',
    execution: { model: 'gpt-6-sol', reasoningEffort: 'high' },
  },
  {
    taskId: 'sample2-exec', rootTaskId: 'sample2-plan', parentTaskId: 'sample2-plan',
    targetAgentId: 'win-google', role: 'executor', stage: 'execution', status: 'completed',
    workUnitId: 'sample2-unit', createdAt: '2026-09-23T07:49:47Z', input: '返回指定验收语句',
    taskSpec: { title: '返回指定验收语句' }, model: 'gemini-3.8-flash-high',
  },
  {
    taskId: 'sample2-review', rootTaskId: 'sample2-plan', parentTaskId: 'sample2-exec',
    targetAgentId: 'win-codex', role: 'reviewer', stage: 'result_review', status: 'completed',
    createdAt: '2026-09-23T07:50:10Z', input: '审核指定验收语句', model: 'gpt-6-sol',
    execution: { model: 'gpt-6-sol', reasoningEffort: 'high' }, submission: { verdict: 'approved' },
  },
  {
    taskId: 'sample2-intake', rootTaskId: 'sample2-plan', parentTaskId: 'sample2-review',
    targetAgentId: 'win-codex', role: 'planner', stage: 'result_intake', status: 'completed',
    createdAt: '2026-09-23T07:50:37Z', completedAt: '2026-09-23T07:51:13Z',
    input: '接收审核结果', model: 'gpt-6-sol', execution: { model: 'gpt-6-sol', reasoningEffort: 'high' },
    submission: { decision: 'complete', needsHuman: false },
  },
]
const sample1Conversation = {
  rootTaskId: '3d9c2bbd-9df1-4acc-a824-9fe9ff99d79d',
  title: '双 Google 账号并发与批次汇合真实验收',
  status: 'completed',
  createdAt: sample1Tasks[0]?.createdAt ?? new Date().toISOString(),
  updatedAt: sample1Tasks[sample1Tasks.length - 1]?.completedAt ?? new Date().toISOString(),
}
const sample2Conversation = {
  rootTaskId: 'e5bf7024-10ad-4ebf-92be-ae43665bc62a',
  title: 'Reviewer Sol 默认策略真实验收',
  status: 'completed',
  createdAt: sample2Tasks[0]?.createdAt ?? new Date().toISOString(),
  updatedAt: sample2Tasks[sample2Tasks.length - 1]?.completedAt ?? new Date().toISOString(),
}

// 2026-09-23 真实三分支验收的最小匿名化回归样本。它保留了原始父子关系：
// 一个失败分支经 human_followup 改派，另一个分支两次驳回后改派，第三个分支直接通过。
const interventionRegressionTasks = [
  {
    taskId: 'real-plan', rootTaskId: 'real-plan', role: 'planner', stage: 'planning',
    status: 'completed', createdAt: '2026-09-23T13:14:31Z', input: '三分支真实验收',
    taskSpec: { title: '三分支协作与界面可读性真实验收' },
  },
  {
    taskId: 'status-original', rootTaskId: 'real-plan', parentTaskId: 'real-plan',
    role: 'executor', stage: 'execution', status: 'failed', workUnitId: 'unit-status',
    createdAt: '2026-09-23T13:15:10Z', input: '检查状态真实性',
    taskSpec: { title: '工作流状态真实性' },
  },
  {
    taskId: 'ui-original', rootTaskId: 'real-plan', parentTaskId: 'real-plan',
    role: 'executor', stage: 'execution', status: 'completed', workUnitId: 'unit-ui',
    superseded: true, supersededBy: 'ui-revision', createdAt: '2026-09-23T13:15:11Z',
    input: '检查三到五分支可读性', taskSpec: { title: '三到五分支界面可读性' },
  },
  {
    taskId: 'semantics-original', rootTaskId: 'real-plan', parentTaskId: 'real-plan',
    role: 'executor', stage: 'execution', status: 'completed', workUnitId: 'unit-semantics',
    createdAt: '2026-09-23T13:15:12Z', input: '检查人工干预语义',
    taskSpec: { title: '人工干预语义' },
  },
  {
    taskId: 'ui-review-1', rootTaskId: 'real-plan', parentTaskId: 'ui-original',
    role: 'reviewer', stage: 'result_review', status: 'completed',
    createdAt: '2026-09-23T13:16:09Z', input: '审核 UI 首稿',
    submission: { verdict: 'rejected', issues: ['首稿缺少量化标准'] },
  },
  {
    taskId: 'semantics-review', rootTaskId: 'real-plan', parentTaskId: 'semantics-original',
    role: 'reviewer', stage: 'result_review', status: 'completed',
    createdAt: '2026-09-23T13:16:28Z', input: '审核干预语义',
    submission: { verdict: 'approved' },
  },
  {
    taskId: 'ui-revision', rootTaskId: 'real-plan', parentTaskId: 'ui-review-1',
    role: 'executor', stage: 'revision', status: 'completed', workUnitId: 'unit-ui', revision: 2,
    createdAt: '2026-09-23T13:16:57Z', input: '修订 UI 分析',
    taskSpec: { title: '三到五分支界面可读性' },
  },
  {
    taskId: 'ui-review-2', rootTaskId: 'real-plan', parentTaskId: 'ui-revision',
    role: 'reviewer', stage: 'result_review', status: 'completed',
    createdAt: '2026-09-23T13:24:09Z', input: '审核 UI 修订稿',
    submission: { verdict: 'rejected', issues: ['仍未满足验收标准'] },
  },
  {
    taskId: 'status-followup', rootTaskId: 'real-plan', parentTaskId: 'status-original',
    role: 'planner', stage: 'human_followup', status: 'completed',
    createdAt: '2026-09-23T13:25:10Z', input: '按人工决定改派状态分支',
  },
  {
    taskId: 'status-replacement', rootTaskId: 'real-plan', parentTaskId: 'status-followup',
    role: 'executor', stage: 'execution', status: 'completed', workUnitId: 'replacement-status',
    createdAt: '2026-09-23T13:25:49Z', input: '替代原失败执行者',
    taskSpec: { title: '工作流状态真实性' },
  },
  {
    taskId: 'status-review', rootTaskId: 'real-plan', parentTaskId: 'status-replacement',
    role: 'reviewer', stage: 'result_review', status: 'completed',
    createdAt: '2026-09-23T13:26:48Z', input: '审核状态替代稿',
    submission: { verdict: 'approved' },
  },
  {
    taskId: 'ui-followup', rootTaskId: 'real-plan', parentTaskId: 'ui-review-2',
    role: 'planner', stage: 'human_followup', status: 'completed',
    createdAt: '2026-09-23T13:34:54Z', input: '按人工意见改派 UI 分支',
  },
  {
    taskId: 'intake-old', rootTaskId: 'real-plan', parentTaskId: 'status-review',
    role: 'planner', stage: 'result_intake', status: 'completed',
    createdAt: '2026-09-23T13:35:22Z', input: '接收状态分支结果',
    submission: { decision: 'needs_human', needsHuman: true },
  },
  {
    taskId: 'ui-replacement', rootTaskId: 'real-plan', parentTaskId: 'ui-followup',
    role: 'executor', stage: 'execution', status: 'completed', workUnitId: 'replacement-ui',
    createdAt: '2026-09-23T13:35:30Z', input: '替代原 UI 执行者',
    taskSpec: { title: '三到五分支界面可读性' },
  },
  {
    taskId: 'ui-review-final', rootTaskId: 'real-plan', parentTaskId: 'ui-replacement',
    role: 'reviewer', stage: 'result_review', status: 'completed',
    createdAt: '2026-09-23T13:38:40Z', input: '审核 UI 替代稿',
    submission: { verdict: 'approved' },
  },
  {
    taskId: 'intake-latest', rootTaskId: 'real-plan', parentTaskId: 'ui-review-final',
    role: 'planner', stage: 'result_intake', status: 'completed',
    createdAt: '2026-09-23T13:39:00Z', input: '接收 UI 分支结果',
    submission: { decision: 'needs_human', needsHuman: true },
  },
]

test('formatAgentDisplayName maps IDs to human-readable names', () => {
  const hostCodex = formatAgentDisplayName('win-0vqsm0he9h6-codex-01', 'win-0vqsm0he9h6', { provider: 'openai' })
  assert.equal(hostCodex.name, '主机 Codex')
  assert.equal(hostCodex.device, '主机')

  const hostGoogle = formatAgentDisplayName('win-0vqsm0he9h6-antigravity-01', 'win-0vqsm0he9h6', { provider: 'google' })
  assert.equal(hostGoogle.name, '主机 Google')
  assert.equal(hostGoogle.device, '主机')

  const laptopCodex = formatAgentDisplayName('device-codex-01', 'device', { provider: 'openai' })
  assert.equal(laptopCodex.name, '笔记本 Codex')
  assert.equal(laptopCodex.device, '笔记本')

  const laptopGoogle = formatAgentDisplayName('device-antigravity-01', 'device', { provider: 'google' })
  assert.equal(laptopGoogle.name, '笔记本 Google')
  assert.equal(laptopGoogle.device, '笔记本')

  const human = formatAgentDisplayName('human')
  assert.equal(human.name, '人类操作者')

  const system = formatAgentDisplayName('system')
  assert.equal(system.name, '系统调度')
})

test('formatModelDisplayName recognizes models, reasoning effort, and high cost flag', () => {
  const solHigh = formatModelDisplayName('gpt-6-sol', 'high')
  assert.equal(solHigh.fullLabel, 'Codex · Sol · High')
  assert.equal(solHigh.isHighCost, false)

  const astra = formatModelDisplayName('gpt-6-astra')
  assert.equal(astra.fullLabel, 'Codex · Astra')
  assert.equal(astra.isHighCost, true)

  const geminiFlash = formatModelDisplayName('gemini-3.8-flash-high')
  assert.equal(geminiFlash.fullLabel, 'Google · Gemini Flash High')
  assert.equal(geminiFlash.isHighCost, false)

  const opus = formatModelDisplayName('claude-opus-4-6-thinking')
  assert.equal(opus.fullLabel, 'Google · Claude Opus')
  assert.equal(opus.isHighCost, true)

  const unassigned = formatModelDisplayName(null)
  assert.equal(unassigned.fullLabel, '尚未分配')
})

test('Sample 1 DAG graph: real concurrency, rejection, revision, and single convergence', () => {
  const graph = buildWorkflowGraph(sample1Tasks, fixtureAgents)

  // 1. 根任务为 Planner 规划
  assert.ok(graph.planningTask)
  assert.equal(graph.planningTask.role, 'planner')
  assert.equal(graph.planningTask.stage, 'planning')
  assert.equal(graph.planningDisplayAgent?.name, '主机 Codex')
  assert.equal(graph.planningDisplayModel?.fullLabel, 'Codex · Sol · High')

  // 2. 并行分支数量恰好为 2
  assert.equal(graph.branches.length, 2)
  const branch1 = graph.branches[0]
  const branch2 = graph.branches[1]

  // 3. 两个分支对应主机 Google 与笔记本 Google
  const agentNames = [branch1.latestStep.displayAgent.name, branch2.latestStep.displayAgent.name]
  assert.ok(agentNames.includes('主机 Google'))
  assert.ok(agentNames.includes('笔记本 Google'))

  // 4. 笔记本分支包含 2 个修订步骤，且首稿被标记为 superseded
  const laptopBranch = graph.branches.find((b) => b.latestStep.displayAgent.name === '笔记本 Google')
  assert.ok(laptopBranch)
  assert.equal(laptopBranch.steps.length, 2)
  assert.equal(laptopBranch.hasRevisions, true)

  // 第 1 步被标记为废弃（降低视觉权重）
  assert.equal(laptopBranch.steps[0].isSuperseded, true)
  assert.equal(laptopBranch.steps[0].reviewerTask?.submission?.verdict, 'rejected')

  // 第 2 步为有效修订版并通过审核
  assert.equal(laptopBranch.steps[1].isSuperseded, false)
  assert.equal(laptopBranch.steps[1].reviewerTask?.submission?.verdict, 'approved')
  assert.equal(laptopBranch.isApproved, true)

  // 5. 最终只有 1 个 Planner 汇合任务 (result_intake)，且汇合了两个成果
  assert.ok(graph.intakeTask)
  assert.equal(graph.intakeTask.stage, 'result_intake')
  assert.equal(graph.intakeDisplayAgent?.name, '主机 Codex')
  assert.equal(graph.intakeDisplayModel?.fullLabel, 'Codex · Sol · High')
  assert.equal(graph.approvedResultCount, 2)
  assert.equal(graph.isConverged, true)
})

test('Sample 1 Issue tracking: rejection detected, clearly explained, and marked resolved', () => {
  const issues = deriveIssues(sample1Tasks)
  assert.equal(issues.length, 1)

  const issue = issues[0]
  assert.equal(issue.kind, 'rejection')
  assert.ok(issue.whatHappened.includes('首稿未通过审核'))
  assert.ok(issue.whatHappened.includes('笔记本 Google'))
  assert.equal(issue.actionTaken, '系统已要求原 Agent 修订。')
  assert.equal(issue.isResolved, true)
  assert.ok(issue.finalOutcome.includes('修订版已通过审核，本问题已解决'))
  assert.ok(issue.details && issue.details.length >= 3)
})

test('Sample 2: legacy 4-phase loop keeps correct models but is not presented as final completion', () => {
  const graph = buildWorkflowGraph(sample2Tasks, fixtureAgents)

  assert.ok(graph.planningTask)
  assert.equal(graph.planningDisplayModel?.fullLabel, 'Codex · Sol · High')

  assert.equal(graph.branches.length, 1)
  const branch = graph.branches[0]
  assert.equal(branch.latestStep.displayAgent.name, '主机 Google')
  assert.equal(branch.latestStep.displayModel.fullLabel, 'Google · Gemini Flash High')

  // Reviewer 必须使用 Sol High，不能显示为 Astra
  assert.ok(branch.latestStep.reviewerTask)
  assert.equal(branch.latestStep.reviewerDisplayModel?.fullLabel, 'Codex · Sol · High')
  assert.equal(branch.latestStep.reviewerDisplayModel?.isHighCost, false)
  assert.equal(branch.latestStep.reviewerTask.submission?.verdict, 'approved')

  // Planner 汇合
  assert.ok(graph.intakeTask)
  assert.equal(graph.intakeDisplayModel?.fullLabel, 'Codex · Sol · High')

  // 状态摘要
  const summary = deriveWorkflowSummary(sample2Tasks, sample2Conversation)
  assert.equal(summary.statusText, '旧流程已结束，等待最终 AI 审核')
  assert.equal(summary.statusTone, 'warning')
  assert.equal(summary.stageText, '待最终审核')
  assert.equal(summary.parallelCount, 1)
})

test('Real 3-branch intervention regression: replacements stay in their original logical branches', () => {
  const graph = buildWorkflowGraph(interventionRegressionTasks)

  assert.equal(graph.branches.length, 3)
  assert.equal(graph.completedBranches, 3)
  assert.equal(graph.hasRejections, true)
  assert.equal(graph.hasUnresolvedIssues, false)

  const statusBranch = graph.branches.find((branch) => branch.workUnitId === 'unit-status')
  const uiBranch = graph.branches.find((branch) => branch.workUnitId === 'unit-ui')
  const semanticsBranch = graph.branches.find((branch) => branch.workUnitId === 'unit-semantics')
  assert.ok(statusBranch)
  assert.ok(uiBranch)
  assert.ok(semanticsBranch)
  assert.equal(statusBranch.steps.length, 2)
  assert.equal(statusBranch.latestStep.task.taskId, 'status-replacement')
  assert.equal(statusBranch.isApproved, true)
  assert.equal(uiBranch.steps.length, 3)
  assert.equal(uiBranch.latestStep.task.taskId, 'ui-replacement')
  assert.equal(uiBranch.isApproved, true)
  assert.equal(semanticsBranch.steps.length, 1)
  assert.equal(semanticsBranch.isApproved, true)

  assert.equal(graph.intakeTask?.taskId, 'intake-latest')
  assert.equal(graph.isConverged, false)
  assert.equal(graph.isFullyCompleted, false)

  const summary = deriveWorkflowSummary(interventionRegressionTasks, {
    rootTaskId: 'real-plan', title: '三分支真实验收', status: 'stalled',
    createdAt: '2026-09-23T13:14:31Z', updatedAt: '2026-09-23T13:39:00Z',
  })
  assert.equal(summary.parallelCount, 3)
  assert.equal(summary.needsHuman, true)
  assert.equal(summary.statusText, '等待你的决定')

  const issues = deriveIssues(interventionRegressionTasks)
  assert.equal(issues.find((issue) => issue.taskId === 'status-original')?.isResolved, true)
  assert.equal(issues.find((issue) => issue.taskId === 'ui-review-2')?.isResolved, true)
})

test('Only the latest review of the effective execution version controls branch approval', () => {
  const tasks = [
    {
      taskId: 'plan-latest-review', role: 'planner', stage: 'planning', status: 'completed',
      createdAt: '2026-09-23T14:00:00Z', input: '测试最新审核',
    },
    {
      taskId: 'exec-latest-review', parentTaskId: 'plan-latest-review', role: 'executor',
      stage: 'execution', status: 'completed', workUnitId: 'unit-latest-review',
      createdAt: '2026-09-23T14:01:00Z', input: '执行',
    },
    {
      taskId: 'review-approved-old', parentTaskId: 'exec-latest-review', role: 'reviewer',
      stage: 'result_review', status: 'completed', createdAt: '2026-09-23T14:02:00Z',
      input: '首次审核', submission: { verdict: 'approved' },
    },
    {
      taskId: 'review-rejected-latest', parentTaskId: 'exec-latest-review', role: 'reviewer',
      stage: 'result_review', status: 'completed', createdAt: '2026-09-23T14:03:00Z',
      input: '复核', submission: { verdict: 'rejected' },
    },
  ]

  const branch = buildWorkflowGraph(tasks).branches[0]
  assert.equal(branch.latestStep.reviewerTask?.taskId, 'review-rejected-latest')
  assert.equal(branch.isApproved, false)
  assert.equal(branch.isRejected, true)
})

test('5-Phase Workflow: final_review extraction, human acceptance gate, and true completion', () => {
  const rootTask = {
    taskId: 'plan-101',
    rootTaskId: 'plan-101',
    role: 'planner',
    stage: 'planning',
    status: 'completed',
    createdAt: '2026-09-23T10:00:00Z',
    input: '五阶段全链路系统设计',
    workflow: {
      finalHumanReviewRequired: true,
      branchControls: {
        'unit-alpha': { paused: false, humanReviewRequired: true },
      },
    },
  }

  const execTask = {
    taskId: 'exec-101',
    rootTaskId: 'plan-101',
    parentTaskId: 'plan-101',
    role: 'executor',
    stage: 'execution',
    status: 'completed',
    workUnitId: 'unit-alpha',
    createdAt: '2026-09-23T10:01:00Z',
    input: '实现模块 alpha',
    humanReviewRequired: true,
    humanReviewStatus: 'approved',
  }

  const reviewTask = {
    taskId: 'rev-101',
    rootTaskId: 'plan-101',
    parentTaskId: 'exec-101',
    role: 'reviewer',
    stage: 'result_review',
    status: 'completed',
    createdAt: '2026-09-23T10:05:00Z',
    submission: { verdict: 'approved', brief: '模块 alpha 审核通过' },
  }

  const intakeTask = {
    taskId: 'intake-101',
    rootTaskId: 'plan-101',
    parentTaskId: 'plan-101',
    role: 'planner',
    stage: 'result_intake',
    status: 'completed',
    createdAt: '2026-09-23T10:10:00Z',
    finalReviewTaskId: 'final-rev-101',
    finalReviewStatus: 'approved',
    finalHumanReviewStatus: 'pending',
  }

  const finalReviewTask = {
    taskId: 'final-rev-101',
    rootTaskId: 'plan-101',
    parentTaskId: 'intake-101',
    role: 'reviewer',
    stage: 'final_review',
    status: 'completed',
    createdAt: '2026-09-23T10:15:00Z',
    input: '独立审核最终聚合成果',
    submission: { verdict: 'approved', brief: '全链路验收合格' },
  }

  const tasks = [rootTask, execTask, reviewTask, intakeTask, finalReviewTask]
  const graph = buildWorkflowGraph(tasks, fixtureAgents)

  // 1. 验证第 5 阶段 final_review 节点被正确识别与提取
  assert.ok(graph.finalReviewTask)
  assert.equal(graph.finalReviewTask.taskId, 'final-rev-101')
  assert.equal(graph.finalReviewStatus, 'approved')

  // 2. 验证分支层的人工验收状态与控制
  assert.equal(graph.branches.length, 1)
  const branchAlpha = graph.branches[0]
  assert.equal(branchAlpha.workUnitId, 'unit-alpha')
  assert.equal(branchAlpha.humanReviewRequired, true)
  assert.equal(branchAlpha.humanReviewStatus, 'approved')
  assert.equal(branchAlpha.isBranchPaused, false)

  // 3. 验证最终人工验收门禁挂起时，尚未全流程结案 (isFullyCompleted === false)
  assert.equal(graph.finalHumanReviewRequired, true)
  assert.equal(graph.finalHumanReviewStatus, 'pending')
  assert.equal(graph.isFullyCompleted, false)

  const summaryPending = deriveWorkflowSummary(tasks)
  assert.equal(summaryPending.statusText, '最终成果已过 AI 终审，等待最终人工验收')
  assert.equal(summaryPending.stageText, '终审验收')

  // 4. 当人工验收通过后，满足真正结案条件 (isFullyCompleted === true)
  intakeTask.finalHumanReviewStatus = 'approved'
  const graphCompleted = buildWorkflowGraph(tasks, fixtureAgents)
  assert.equal(graphCompleted.finalHumanReviewStatus, 'approved')
  assert.equal(graphCompleted.isFullyCompleted, true)

  const summaryCompleted = deriveWorkflowSummary(tasks)
  assert.equal(summaryCompleted.statusText, '工作流已全流程通过并结案')
  assert.equal(summaryCompleted.statusTone, 'success')
  assert.equal(summaryCompleted.stageText, '已完成')
})

test('Intervention controls: branch pause, workflow pause, planning hold, and final review issue tracking', () => {
  const rootTask = {
    taskId: 'plan-202',
    rootTaskId: 'plan-202',
    role: 'planner',
    stage: 'planning',
    status: 'completed',
    createdAt: '2026-09-23T11:00:00Z',
    input: '测试干预控制',
    workflow: {
      paused: true,
      planningHold: true,
      planRevision: 2,
      branchControls: {
        'unit-beta': { paused: true, humanReviewRequired: false },
      },
    },
  }

  const execTask = {
    taskId: 'exec-202',
    rootTaskId: 'plan-202',
    parentTaskId: 'plan-202',
    role: 'executor',
    stage: 'execution',
    status: 'running',
    workUnitId: 'unit-beta',
    dispatchHold: 'branch_paused',
    createdAt: '2026-09-23T11:01:00Z',
    input: '模块 beta 执行中',
  }

  const intakeTask = {
    taskId: 'intake-202',
    rootTaskId: 'plan-202',
    parentTaskId: 'plan-202',
    role: 'planner',
    stage: 'result_intake',
    status: 'completed',
    createdAt: '2026-09-23T11:10:00Z',
  }

  const finalReviewTask = {
    taskId: 'final-rev-202',
    rootTaskId: 'plan-202',
    parentTaskId: 'intake-202',
    role: 'reviewer',
    stage: 'final_review',
    status: 'completed',
    createdAt: '2026-09-23T11:15:00Z',
    submission: {
      verdict: 'rejected',
      brief: '聚合结果未达到性能基准',
      issues: ['吞吐量不足 500 RPS', '内存占用超标'],
    },
  }

  const tasks = [rootTask, execTask, intakeTask, finalReviewTask]
  const graph = buildWorkflowGraph(tasks, fixtureAgents)

  // 1. 验证工作流暂停与规划屏障
  assert.equal(graph.isWorkflowPaused, true)
  assert.equal(graph.planningHold, true)
  assert.equal(graph.planRevision, 2)

  // 2. 验证分支暂停状态
  const branchBeta = graph.branches.find((b) => b.workUnitId === 'unit-beta')
  assert.ok(branchBeta)
  assert.equal(branchBeta.isBranchPaused, true)

  // 3. 验证汇总状态反应暂停
  const summaryPaused = deriveWorkflowSummary(tasks)
  assert.equal(summaryPaused.statusText, '工作流已暂停')
  assert.equal(summaryPaused.stageText, '已暂停')

  // 4. 验证 final_review 驳回记录作为 issue 被捕获并归类
  const issues = deriveIssues(tasks)
  const finalIssue = issues.find((i) => i.taskId === 'final-rev-202')
  assert.ok(finalIssue)
  assert.equal(finalIssue.kind, 'rejection')
  assert.equal(finalIssue.affectedBranch, '最终成果 AI 终审')
  assert.equal(finalIssue.isResolved, false)
  assert.ok(finalIssue.details.includes('吞吐量不足 500 RPS'))
})
