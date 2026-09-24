import type {
  AccountProfile,
  Agent,
  AgentDisplayInfo,
  Conversation,
  HubTask,
  HumanIntervention,
  ModelDisplayInfo,
  WorkflowBranch,
  WorkflowGraph,
  WorkflowIssue,
  WorkflowNodeStep,
  WorkflowSummary,
} from './types'

/**
 * 格式化人类可读的 Agent 名称与设备归属
 * 示例：主机 Codex、主机 Google、笔记本 Codex、笔记本 Google
 */
export function formatAgentDisplayName(
  agentId?: string | null,
  deviceId?: string | null,
  account?: AccountProfile | null,
  adapter?: string,
): AgentDisplayInfo {
  if (!agentId || agentId === 'system') {
    return {
      name: '系统调度',
      rawId: agentId ?? 'system',
      device: '系统',
      engine: 'System',
      roleLabel: '系统',
    }
  }

  if (agentId === 'human') {
    return {
      name: '人类操作者',
      rawId: 'human',
      device: '人工',
      engine: 'Human',
      roleLabel: '操作者',
    }
  }

  const rawLower = agentId.toLowerCase()
  const deviceLower = (deviceId ?? '').toLowerCase()
  const adapterLower = (adapter ?? '').toLowerCase()
  const providerLower = (account?.provider ?? '').toLowerCase()

  // 1. 判断设备所在
  let deviceName = '工作设备'
  if (deviceLower.includes('win') || rawLower.startsWith('win-') || deviceLower.includes('host')) {
    deviceName = '主机'
  } else if (
    deviceLower.includes('device') ||
    deviceLower.includes('laptop') ||
    deviceLower.includes('notebook') ||
    rawLower.startsWith('device-')
  ) {
    deviceName = '笔记本'
  } else if (deviceId) {
    deviceName = deviceId
  }

  // 2. 判断所属平台/引擎
  let engineName = agentId
  if (
    rawLower.includes('antigravity') ||
    rawLower.includes('google') ||
    adapterLower.includes('antigravity') ||
    providerLower.includes('google')
  ) {
    engineName = 'Google'
  } else if (
    rawLower.includes('codex') ||
    rawLower.includes('openai') ||
    adapterLower.includes('codex') ||
    providerLower.includes('openai')
  ) {
    engineName = 'Codex'
  } else if (rawLower.includes('claude') || providerLower.includes('anthropic')) {
    engineName = 'Claude'
  }

  const fullName = `${deviceName} ${engineName}`

  return {
    name: fullName,
    rawId: agentId,
    device: deviceName,
    engine: engineName,
    roleLabel: engineName,
  }
}

/**
 * 格式化模型名称与推理强度，并标识高成本模型
 * 示例：Codex · Sol · High、Google · Gemini Flash High、Codex · Astra
 */
export function formatModelDisplayName(
  model?: string | null,
  reasoningEffort?: string | null,
): ModelDisplayInfo {
  if (!model || model.trim() === '') {
    return {
      modelLabel: '尚未分配',
      effortLabel: null,
      isHighCost: false,
      fullLabel: '尚未分配',
    }
  }

  const cleanModel = model.trim()
  const lower = cleanModel.toLowerCase()

  // 检查是否为高成本模型（Astra / Opus 等）
  const isHighCost = /astra|opus|ultra|max/i.test(lower)

  // 友好模型名称转换
  let modelLabel = cleanModel
  if (lower === 'gpt-6-sol') {
    modelLabel = 'Codex · Sol'
  } else if (lower === 'gpt-6-astra') {
    modelLabel = 'Codex · Astra'
  } else if (lower === 'gpt-6-luna') {
    modelLabel = 'Codex · Luna'
  } else if (lower === 'gpt-5.6-sol') {
    modelLabel = 'Codex · Sol 5.6'
  } else if (lower === 'gpt-5.6-terra') {
    modelLabel = 'Codex · Terra 5.6'
  } else if (lower === 'gpt-5.6-luna') {
    modelLabel = 'Codex · Luna 5.6'
  } else if (lower === 'gpt-5.5') {
    modelLabel = 'Codex · GPT-5.5'
  } else if (lower === 'gemini-3.8-flash-high') {
    modelLabel = 'Google · Gemini Flash High'
  } else if (lower === 'gemini-3.8-flash-low') {
    modelLabel = 'Google · Gemini Flash Low'
  } else if (lower === 'gemini-2.5-pro') {
    modelLabel = 'Google · Gemini Pro 2.5'
  } else if (lower === 'gemini-2.5-flash') {
    modelLabel = 'Google · Gemini Flash 2.5'
  } else if (lower.includes('claude-opus')) {
    modelLabel = 'Google · Claude Opus'
  } else if (lower.includes('claude-sonnet')) {
    modelLabel = 'Claude Sonnet'
  } else if (lower.includes('gpt-oss-120b')) {
    modelLabel = 'GPT-OSS 120B'
  } else if (lower.startsWith('gpt-')) {
    modelLabel = `Codex · ${cleanModel.slice(4)}`
  } else if (lower.startsWith('gemini-')) {
    modelLabel = `Google · ${cleanModel.slice(7)}`
  }

  // 推理强度标签
  let effortLabel: string | null = null
  if (reasoningEffort) {
    const effortLower = reasoningEffort.toLowerCase()
    if (effortLower === 'high') effortLabel = 'High'
    else if (effortLower === 'medium') effortLabel = 'Medium'
    else if (effortLower === 'low') effortLabel = 'Low'
    else if (effortLower === 'xhigh') effortLabel = 'XHigh'
    else effortLabel = reasoningEffort
  }

  // 避免在模型名称已经包含 Flash High 的情况下重复 High
  const fullLabel =
    effortLabel && !modelLabel.toLowerCase().endsWith(effortLabel.toLowerCase())
      ? `${modelLabel} · ${effortLabel}`
      : modelLabel

  return {
    modelLabel,
    effortLabel,
    isHighCost,
    fullLabel,
  }
}

/**
 * 解析任务实际使用的模型与推理强度
 * 优先级：task.model > task.execution.model > 未知
 */
export function resolveTaskModelInfo(task?: HubTask | null): ModelDisplayInfo {
  if (!task) {
    return {
      modelLabel: '尚未分配',
      effortLabel: null,
      isHighCost: false,
      fullLabel: '尚未分配',
    }
  }

  const model = task.model ?? task.execution?.model ?? null
  const effort = task.execution?.reasoningEffort ?? task.reasoningEffort ?? null

  return formatModelDisplayName(model, effort)
}

/**
 * 解析任务对应的 Agent 展示信息
 */
export function resolveTaskAgentInfo(task?: HubTask | null, agents: Agent[] = []): AgentDisplayInfo {
  const targetId = task?.targetAgentId ?? task?.requestedAgentId ?? task?.sourceAgentId ?? null
  const agent = agents.find((item) => item.agentId === targetId)
  return formatAgentDisplayName(targetId, agent?.deviceId, agent?.account, agent?.adapter)
}

function taskTimestamp(task: HubTask): number {
  return new Date(task.createdAt).getTime()
}

function latestTask(tasks: HubTask[]): HubTask | undefined {
  return tasks.reduce<HubTask | undefined>(
    (latest, task) => (!latest || taskTimestamp(task) >= taskTimestamp(latest) ? task : latest),
    undefined,
  )
}

/**
 * Resolve an execution attempt to its stable logical branch.
 *
 * New Hub versions can provide logicalBranchId/replacesWorkUnitId directly. For
 * existing LAN state, replacement executors are children of a human_followup
 * Planner whose ancestry points back to the original reviewer/executor. Walking
 * that chain prevents a replacement from being rendered as a brand-new branch.
 */
function resolveLogicalBranchId(
  task: HubTask,
  taskById: Map<string, HubTask>,
): string {
  if (task.logicalBranchId) return task.logicalBranchId
  if (task.replacesWorkUnitId) return task.replacesWorkUnitId

  const visited = new Set<string>([task.taskId])
  let cursor = task.parentTaskId ? taskById.get(task.parentTaskId) : undefined
  while (cursor && !visited.has(cursor.taskId)) {
    visited.add(cursor.taskId)
    const isExecutor =
      cursor.role === 'executor' || cursor.stage === 'execution' || cursor.stage === 'revision'
    if (isExecutor) {
      return cursor.logicalBranchId ?? cursor.replacesWorkUnitId ?? cursor.workUnitId ?? cursor.taskId
    }
    cursor = cursor.parentTaskId ? taskById.get(cursor.parentTaskId) : undefined
  }

  if (task.supersedesTaskId) {
    const superseded = taskById.get(task.supersedesTaskId)
    if (superseded) return resolveLogicalBranchId(superseded, taskById)
  }

  return task.workUnitId ?? task.taskId
}

function isActiveStatus(status: string): boolean {
  return ['queued', 'dispatched', 'accepted', 'running', 'awaiting_approval', 'paused'].includes(
    status,
  )
}

function isIntakeConverged(task?: HubTask): boolean {
  if (!task || task.status !== 'completed' || task.submission?.needsHuman) return false
  const decision = task.submission?.decision?.toLowerCase()
  return !decision || decision === 'complete'
}

/**
 * 构建多 Agent 协作工作流 DAG 图模型
 * 支持：
 * - 根规划任务 (planning)
 * - 真实并发分支并列排布 (grouped by workUnitId)
 * - 审核节点成对紧随执行节点
 * - 同一分支下的修订链 (revision 1 -> 2)
 * - 废弃的旧版本降低视觉权重但不消失 (superseded)
 * - 批次成果汇合点 (result_intake)
 */
export function buildWorkflowGraph(tasks: HubTask[] = [], agents: Agent[] = []): WorkflowGraph {
  const allTasks = [...tasks].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )

  // 1. 寻找 Planner 规划任务
  const planningTask = allTasks.find(
    (t) => t.role === 'planner' && (t.stage === 'planning' || t.parentTaskId === undefined),
  )

  const taskById = new Map(allTasks.map((task) => [task.taskId, task]))

  // 2. 只使用最新有效的 Planner 汇合任务；旧 intake 仍保留在时间线中。
  const intakeCandidates = allTasks.filter(
    (t) => t.role === 'planner' && t.stage === 'result_intake',
  )
  const intakeTask =
    latestTask(intakeCandidates.filter((task) => task.status !== 'cancelled')) ??
    latestTask(intakeCandidates)

  // 3. 筛选所有执行与修订任务
  const executorTasks = allTasks.filter(
    (t) => t.role === 'executor' || t.stage === 'execution' || t.stage === 'revision',
  )

  // 4. 筛选所有审核任务
  const reviewerTasks = allTasks.filter(
    (t) => t.role === 'reviewer' || t.stage === 'result_review',
  )

  // 5. 按稳定逻辑分支分组。人工改派和重新执行属于原分支的后续版本。
  const branchMap = new Map<string, HubTask[]>()
  for (const execTask of executorTasks) {
    const unitKey = resolveLogicalBranchId(execTask, taskById)
    const list = branchMap.get(unitKey) ?? []
    list.push(execTask)
    branchMap.set(unitKey, list)
  }

  const branches: WorkflowBranch[] = []
  let hasRejections = false
  let hasUnresolvedIssues = false

  for (const [workUnitId, execList] of branchMap.entries()) {
    // replacement 的 revision 可能重新从 1 开始，因此以真实创建顺序为准。
    execList.sort((a, b) => taskTimestamp(a) - taskTimestamp(b))

    const steps: WorkflowNodeStep[] = []

    for (const [stepIndex, execTask] of execList.entries()) {
      // 同一执行版本如果产生多个审核，只认最后一次有效结论。
      const revTask = latestTask(
        reviewerTasks.filter(
          (r) => r.taskId === execTask.reviewTaskId || r.parentTaskId === execTask.taskId,
        ),
      )

      if (revTask?.submission?.verdict === 'rejected') {
        hasRejections = true
      }

      const isSuperseded = Boolean(
        execTask.superseded ||
          execTask.supersededBy ||
          stepIndex < execList.length - 1,
      )

      steps.push({
        task: execTask,
        isSuperseded,
        displayAgent: resolveTaskAgentInfo(execTask, agents),
        displayModel: resolveTaskModelInfo(execTask),
        reviewerTask: revTask,
        reviewerDisplayAgent: revTask ? resolveTaskAgentInfo(revTask, agents) : undefined,
        reviewerDisplayModel: revTask ? resolveTaskModelInfo(revTask) : undefined,
      })
    }

    const latestStep = steps[steps.length - 1]
    const latestVerdict = latestStep.reviewerTask?.submission?.verdict
    const branchApproved = latestVerdict === 'approved'
    const branchRejected = latestVerdict === 'rejected'
    const branchTitle =
      latestStep.task.taskSpec?.title ??
      latestStep.task.input.slice(0, 30) ??
      `工作单元 ${workUnitId.slice(-6)}`

    // 分支是否挂起未完
    const isPending = Boolean(
      isActiveStatus(latestStep.task.status) ||
        (latestStep.reviewerTask && isActiveStatus(latestStep.reviewerTask.status)) ||
        (latestStep.task.status === 'completed' && !latestStep.reviewerTask),
    )

    if (
      branchRejected ||
      latestStep.task.status === 'failed' ||
      latestStep.task.status === 'rejected' ||
      latestStep.task.status === 'cancelled'
    ) {
      hasUnresolvedIssues = true
    }

    const branchControl = planningTask?.workflow?.branchControls?.[workUnitId]
    const isBranchPaused = Boolean(
      branchControl?.paused ||
        latestStep.task.status === 'paused' ||
        latestStep.task.dispatchHold === 'branch_paused',
    )
    const humanReviewRequired = Boolean(
      branchControl?.humanReviewRequired || latestStep.task.humanReviewRequired,
    )
    const humanReviewStatus =
      (latestStep.task.humanReviewStatus as
        | 'not_required'
        | 'pending'
        | 'approved'
        | 'rejected'
        | null) ?? (humanReviewRequired ? 'pending' : 'not_required')

    branches.push({
      workUnitId,
      title: branchTitle,
      steps,
      latestStep,
      isApproved: branchApproved,
      isRejected: branchRejected,
      isPending,
      isSuperseded: Boolean(latestStep.isSuperseded),
      hasRevisions: steps.length > 1,
      isBranchPaused,
      humanReviewRequired,
      humanReviewStatus,
    })
  }

  // 6. 计算汇合结果数量
  let approvedResultCount = branches.filter((b) => b.isApproved).length
  if (intakeTask?.contextBundle && Array.isArray(intakeTask.contextBundle.approvedResults)) {
    approvedResultCount = intakeTask.contextBundle.approvedResults.length
  }

  const completedBranches = branches.filter(
    (branch) =>
      branch.isApproved &&
      !branch.isPending &&
      (!branch.humanReviewRequired || branch.humanReviewStatus === 'approved'),
  ).length

  // 7. 寻找第 5 阶段最终聚合审核 (final_review)
  const finalReviewTask = latestTask(
    allTasks.filter(
      (t) =>
        t.role === 'reviewer' &&
        (t.stage === 'final_review' ||
          t.taskId === intakeTask?.finalReviewTaskId ||
          (intakeTask && t.parentTaskId === intakeTask.taskId)),
    ),
  )

  const finalReviewStatus =
    intakeTask?.finalReviewStatus ??
    (finalReviewTask?.submission?.verdict ? String(finalReviewTask.submission.verdict) : null)

  const finalHumanReviewRequired = Boolean(
    planningTask?.workflow?.finalHumanReviewRequired ||
      intakeTask?.workflow?.finalHumanReviewRequired,
  )

  const finalHumanReviewStatus =
    intakeTask?.finalHumanReviewStatus ??
    (finalHumanReviewRequired && finalReviewStatus === 'approved' ? 'pending' : 'not_required')

  const isWorkflowPaused = Boolean(
    planningTask?.workflow?.paused ||
      allTasks.some((t) => t.dispatchHold === 'workflow_paused'),
  )

  const planningHold = Boolean(
    planningTask?.workflow?.planningHold ||
      allTasks.some((t) => t.stage === 'replan' && t.status === 'running'),
  )

  const planRevision = planningTask?.workflow?.planRevision ?? 1

  // 是否真正全流程完成（针对第 5 阶段终审闭环）：
  // 必须最终 AI 审核通过且人工最终验收完成（若开启门禁）
  const isConverged = isIntakeConverged(intakeTask)
  const isFullyCompleted = Boolean(
    isConverged &&
      finalReviewTask &&
      finalReviewStatus === 'approved' &&
      branches.length > 0 &&
      completedBranches === branches.length &&
      (!finalHumanReviewRequired || finalHumanReviewStatus === 'approved'),
  )

  return {
    planningTask,
    planningDisplayAgent: planningTask ? resolveTaskAgentInfo(planningTask, agents) : undefined,
    planningDisplayModel: planningTask ? resolveTaskModelInfo(planningTask) : undefined,
    branches,
    intakeTask,
    intakeDisplayAgent: intakeTask ? resolveTaskAgentInfo(intakeTask, agents) : undefined,
    intakeDisplayModel: intakeTask ? resolveTaskModelInfo(intakeTask) : undefined,
    finalReviewTask,
    finalReviewDisplayAgent: finalReviewTask
      ? resolveTaskAgentInfo(finalReviewTask, agents)
      : undefined,
    finalReviewDisplayModel: finalReviewTask
      ? resolveTaskModelInfo(finalReviewTask)
      : undefined,
    finalReviewStatus,
    finalHumanReviewStatus,
    finalHumanReviewRequired,
    isWorkflowPaused,
    planningHold,
    planRevision,
    approvedResultCount,
    totalBranches: branches.length,
    completedBranches,
    hasRejections,
    hasUnresolvedIssues,
    isConverged,
    isFullyCompleted,
    allTasks,
  }
}

/**
 * 统一问题与恢复说明提取
 * 发生了什么、影响哪个分支、系统采取了什么措施、是否已解决、最终结果
 */
export function deriveIssues(tasks: HubTask[] = []): WorkflowIssue[] {
  const issues: WorkflowIssue[] = []
  const graph = buildWorkflowGraph(tasks)

  // 1. 审核拒绝事件
  const reviewerTasks = tasks.filter((t) => t.role === 'reviewer' && t.submission?.verdict === 'rejected')
  for (const rev of reviewerTasks) {
    const parentExec = tasks.find(
      (t) => t.taskId === rev.parentTaskId || t.reviewTaskId === rev.taskId,
    )
    const agentName = formatAgentDisplayName(parentExec?.targetAgentId).name
    const branch = graph.branches.find((b) =>
      b.steps.some((s) => s.task.taskId === parentExec?.taskId || s.reviewerTask?.taskId === rev.taskId),
    )

    const isFinalReview =
      rev.stage === 'final_review' || rev.taskId === graph.finalReviewTask?.taskId
    const isResolved = isFinalReview
      ? graph.finalReviewStatus === 'approved'
      : Boolean(branch?.isApproved)
    const whatHappened = isFinalReview
      ? `${formatAgentDisplayName(rev.targetAgentId).name} 驳回了 Planner 汇总的最终成果`
      : `${agentName} 的首稿未通过审核`
    const affectedBranch = isFinalReview
      ? '最终成果 AI 终审'
      : branch?.title ?? parentExec?.taskSpec?.title ?? '执行分支'
    const actionTaken = isFinalReview
      ? '系统已要求 Planner 重新汇总或由人工处理。'
      : '系统已要求原 Agent 修订。'
    const finalOutcome = isResolved
      ? isFinalReview
        ? '最终成果终审已通过，本问题已解决。'
        : '修订版已通过审核，本问题已解决。'
      : isFinalReview
        ? '等待重新汇总或人工处理。'
        : '修订进行中或等待进一步审核。'

    const reasons: string[] = []
    if (rev.submission?.issues && rev.submission.issues.length > 0) {
      reasons.push(...rev.submission.issues)
    } else if (rev.submission?.brief) {
      reasons.push(rev.submission.brief)
    }

    issues.push({
      issueId: `rejection-${rev.taskId}`,
      taskId: rev.taskId,
      taskTitle: rev.taskSpec?.title ?? '成果审核',
      role: 'reviewer',
      agentName,
      affectedBranch,
      kind: 'rejection',
      whatHappened,
      actionTaken,
      isResolved,
      finalOutcome,
      details: reasons,
    })
  }

  // 2. 调度错误事件
  const schedulingErrors = tasks.filter((t) => Boolean(t.schedulingError))
  for (const t of schedulingErrors) {
    const isResolved = t.status === 'completed' || tasks.some((other) => other.parentTaskId === t.parentTaskId && other.status === 'completed')
    issues.push({
      issueId: `sched-${t.taskId}`,
      taskId: t.taskId,
      taskTitle: t.taskSpec?.title ?? t.taskId,
      role: t.role ?? 'executor',
      agentName: formatAgentDisplayName(t.targetAgentId ?? t.requestedAgentId).name,
      affectedBranch: t.taskSpec?.title ?? '任务调度',
      kind: 'scheduling',
      whatHappened: `调度异常：${t.schedulingError}`,
      actionTaken: '调度器已记录异常并进入退避重试或等待就绪 Agent。',
      isResolved,
      finalOutcome: isResolved ? '已恢复正常调度并完成。' : '尚未恢复，可能需要检查 Agent 状态。',
      details: t.schedulingErrorDetails ? [JSON.stringify(t.schedulingErrorDetails)] : undefined,
    })
  }

  // 3. 执行失败事件
  const failedTasks = tasks.filter((t) => t.status === 'failed')
  for (const t of failedTasks) {
    // 若已有复审拒绝，不重复作为通用失败记录
    if (t.role === 'reviewer' && t.submission?.verdict === 'rejected') continue

    const branch = graph.branches.find((candidate) =>
      candidate.steps.some((step) => step.task.taskId === t.taskId),
    )
    const isResolved = Boolean(branch?.isApproved)

    issues.push({
      issueId: `failed-${t.taskId}`,
      taskId: t.taskId,
      taskTitle: t.taskSpec?.title ?? t.taskId,
      role: t.role ?? 'executor',
      agentName: formatAgentDisplayName(t.targetAgentId).name,
      affectedBranch: t.taskSpec?.title ?? '执行步骤',
      kind: 'error',
      whatHappened: `执行失败：${t.error?.message ?? '步骤异常中断'}`,
      actionTaken: '系统已捕获故障并记录错误日志。',
      isResolved,
      finalOutcome: isResolved ? '后续修订已成功，故障已恢复。' : '步骤执行失败，尚未恢复。',
      details: t.error?.reasons,
    })
  }

  return issues
}

/**
 * 提炼一句话总体状态与进度指标
 */
export function deriveWorkflowSummary(
  tasks: HubTask[] = [],
  conversation?: Conversation | null,
  interventions: HumanIntervention[] = [],
): WorkflowSummary {
  const graph = buildWorkflowGraph(tasks)
  const totalTasks = tasks.length
  const completedTasks = tasks.filter((t) => t.status === 'completed').length

  const pendingInterventions = interventions.filter(
    (item) => item.status === 'pending' || item.status === 'required',
  )
  const needsHuman =
    pendingInterventions.length > 0 || Boolean(graph.intakeTask?.submission?.needsHuman)

  let statusText = '正在处理任务'
  let statusTone: WorkflowSummary['statusTone'] = 'active'
  let stageText = '进行中'

  const rawStatus = conversation?.status ?? (totalTasks > 0 ? tasks[0].status : 'active')

  if (graph.isWorkflowPaused) {
    statusText = '工作流已暂停'
    statusTone = 'warning'
    stageText = '已暂停'
  } else if (graph.planningHold) {
    statusText = '正在由 Planner 重新调整计划（规划屏障生效中）'
    statusTone = 'warning'
    stageText = '调整计划'
  } else if (needsHuman) {
    statusText = '等待你的决定'
    statusTone = 'warning'
    stageText = '人工介入'
  } else if (graph.finalHumanReviewStatus === 'pending') {
    statusText = '最终成果已过 AI 终审，等待最终人工验收'
    statusTone = 'warning'
    stageText = '终审验收'
  } else if (graph.isFullyCompleted) {
    statusText = '工作流已全流程通过并结案'
    statusTone = 'success'
    stageText = '已完成'
  } else if (rawStatus === 'completed') {
    statusText = '旧流程已结束，等待最终 AI 审核'
    statusTone = 'warning'
    stageText = '待最终审核'
  } else if (rawStatus === 'failed') {
    statusText = '执行失败，尚未恢复'
    statusTone = 'error'
    stageText = '执行失败'
  } else if (rawStatus === 'stalled') {
    statusText = '任务停滞未决，需干预'
    statusTone = 'warning'
    stageText = '停滞未决'
  } else if (rawStatus === 'cancelled') {
    statusText = '工作流已取消'
    statusTone = 'neutral'
    stageText = '已取消'
  } else {
    // 动态判断运行中阶段
    const activeTasks = tasks.filter((t) => t.status === 'running')
    const activeExecutors = activeTasks.filter((t) => t.role === 'executor')
    const activeRevisions = activeTasks.filter((t) => t.stage === 'revision')

    if (activeTasks.some((t) => t.stage === 'planning')) {
      statusText = '正在规划任务'
      stageText = '任务规划'
    } else if (activeRevisions.length > 0) {
      statusText = `${activeRevisions.length} 个分支正在根据审核意见修订`
      stageText = '成果修订'
      statusTone = 'warning'
    } else if (activeExecutors.length > 1) {
      statusText = `${activeExecutors.length} 个 Agent 正在并行执行`
      stageText = '并行执行'
    } else if (activeExecutors.length === 1) {
      statusText = '1 个 Agent 正在执行'
      stageText = '执行中'
    } else if (graph.intakeTask?.status === 'running' || (graph.completedBranches === graph.totalBranches && graph.totalBranches > 0)) {
      statusText = '全部分支已通过审核，正在汇总成果'
      stageText = '汇总闭环'
    } else if (activeTasks.some((t) => t.stage === 'result_review')) {
      statusText = '审核 Agent 正在复核成果'
      stageText = '成果审核'
    }
  }

  const startTime = conversation?.createdAt ?? (tasks[0]?.createdAt || undefined)

  return {
    title: conversation?.title ?? tasks[0]?.taskSpec?.title ?? '协作任务',
    statusText,
    statusTone,
    stageText,
    parallelCount: graph.branches.length,
    completedStepCount: completedTasks,
    totalStepCount: totalTasks,
    startTime,
    durationOrCompletionTime: formatDurationOrCompletion(tasks, conversation),
    needsHuman,
    rawStatus,
  }
}

function formatDurationOrCompletion(tasks: HubTask[], conversation?: Conversation | null): string {
  const start = conversation?.createdAt ?? tasks[0]?.createdAt
  if (!start) return ''

  const startDate = new Date(start)
  const isDone = conversation?.status === 'completed' || tasks.every((t) => t.status === 'completed' && tasks.length > 0)

  if (isDone) {
    const end = conversation?.updatedAt ?? tasks[tasks.length - 1]?.completedAt ?? new Date().toISOString()
    const diffSec = Math.max(1, Math.round((new Date(end).getTime() - startDate.getTime()) / 1000))
    if (diffSec < 60) return `用时 ${diffSec} 秒`
    return `用时 ${Math.floor(diffSec / 60)} 分 ${diffSec % 60} 秒`
  }

  const diffMin = Math.max(0, Math.floor((Date.now() - startDate.getTime()) / 60000))
  if (diffMin < 1) return '刚刚开始'
  if (diffMin < 60) return `已运行 ${diffMin} 分钟`
  return `已运行 ${Math.floor(diffMin / 60)} 小时 ${diffMin % 60} 分钟`
}
