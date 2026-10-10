import type { Agent, HubTask, WebUser } from '../types'
import { buildWorkflowGraph } from '../workflow-view-model'
import { TechnicalDetails } from './TechnicalDetails'

interface WorkflowMapProps {
  tasks: HubTask[]
  agents: Agent[]
  currentUser?: WebUser | null
  canWrite: boolean
  workingAction: string
  activeTaskStatuses: Set<string>
  onCancelTask: (task: HubTask) => void
  onPauseBranch?: (workUnitId: string) => void
  onResumeBranch?: (workUnitId: string) => void
  onToggleBranchReviewPolicy?: (workUnitId: string, required: boolean) => void
  onToggleWorkflowReviewPolicy?: (required: boolean) => void
}

export function WorkflowMap({
  tasks,
  agents,
  currentUser,
  canWrite,
  workingAction,
  activeTaskStatuses,
  onCancelTask,
  onPauseBranch,
  onResumeBranch,
  onToggleBranchReviewPolicy,
  onToggleWorkflowReviewPolicy,
}: WorkflowMapProps) {
  const graph = buildWorkflowGraph(tasks, agents)

  if (tasks.length === 0) {
    return <div className="workflow-map-empty">尚未加载步骤数据</div>
  }

  return (
    <section className="workflow-dag" aria-label="任务协作关系图">
      <div className="dag-section-title">
        <div className="title-left">
          <strong>任务协作关系图</strong>
          <span className="dag-badge">
            {graph.totalBranches > 1 ? `${graph.totalBranches} 路并行` : '单线执行'}
            {graph.isFullyCompleted
              ? ' · 五阶段全流程完成'
              : graph.isConverged
              ? ' · 汇合完成'
              : ''}
          </span>
          {graph.isWorkflowPaused && <span className="dag-paused-badge">⏸ 工作流已暂停</span>}
          {graph.planningHold && <span className="dag-hold-badge">🔄 调整计划屏障中</span>}
        </div>
        <small className="dag-hint">
          直观呈现规划、并发执行、复审修订、成果汇合与最终 AI 审核闭环
        </small>
      </div>

      <div className="dag-container">
        {/* 1. 顶层：人类任务发起 */}
        <div className="dag-node human-node">
          <div className="dag-node-header">
            <span className="node-role-tag human">发起人</span>
            <span className="node-time">人类任务输入</span>
          </div>
          <div className="dag-node-body">
            <strong>业务目标输入</strong>
            <p>{graph.planningTask?.input || '接收人工协作需求'}</p>
          </div>
        </div>

        {/* 向下连接箭头 */}
        <div className="dag-connector">
          <span className="connector-line" />
          <span className="connector-arrow">↓ 派发规划</span>
        </div>

        {/* 2. 规划层：Planner */}
        {graph.planningTask && (
          <div className={`dag-node planner-node ${graph.planningTask.status}`}>
            <div className="dag-node-header">
              <span className="node-role-tag planner">规划 Agent</span>
              <strong className="node-agent-name">
                {graph.planningDisplayAgent?.name ?? '主机 Codex'}
              </strong>
              <span
                className={`node-model-tag ${
                  graph.planningDisplayModel?.isHighCost ? 'high-cost' : ''
                }`}
              >
                {graph.planningDisplayModel?.fullLabel}
              </span>
              <span className={`node-status-pill ${graph.planningTask.status}`}>
                {graph.planningTask.status === 'completed'
                  ? '规划完成'
                  : graph.planningTask.status === 'running'
                  ? '正在规划'
                  : graph.planningTask.status}
              </span>
            </div>
            <div className="dag-node-body">
              <p>
                {graph.planningTask.submission?.brief ||
                  graph.planningTask.taskSpec?.title ||
                  graph.planningTask.input}
              </p>
            </div>
            {currentUser?.role === 'admin' &&
              activeTaskStatuses.has(graph.planningTask.status) && (
                <button
                  type="button"
                  className="dag-cancel-btn"
                  disabled={!canWrite || Boolean(workingAction)}
                  onClick={() => onCancelTask(graph.planningTask!)}
                >
                  取消
                </button>
              )}
          </div>
        )}

        {/* 分支派发提示 */}
        {graph.branches.length > 0 && (
          <div className="dag-connector fan-out">
            <span className="connector-line" />
            <span className="connector-badge">
              并发派发 {graph.branches.length} 个独立工作单元
            </span>
          </div>
        )}

        {/* 3. 并行分支层（并列排布，同一 workUnitId 的修订链在同一分支纵向延伸） */}
        <div className="dag-branches-grid">
          {graph.branches.map((branch, branchIndex) => (
            <div
              className={`dag-branch-column ${branch.isApproved ? 'approved' : ''} ${
                branch.isRejected ? 'has-rejection' : ''
              } ${branch.isBranchPaused ? 'paused' : ''}`}
              key={branch.workUnitId || branchIndex}
            >
              <div className="branch-column-header">
                <div className="branch-title-row">
                  <span className="branch-num-badge">分支 {branchIndex + 1}</span>
                  <strong className="branch-title">{branch.title}</strong>
                  {branch.isBranchPaused && <span className="branch-paused-badge">⏸ 已暂停</span>}
                </div>
                <div className="branch-meta-row">
                  <span
                    className={`branch-status-tag ${
                      branch.isApproved
                        ? 'approved'
                        : branch.isRejected
                        ? 'rejected'
                        : 'running'
                    }`}
                  >
                    {branch.isApproved
                      ? '✓ 审核通过'
                      : branch.isRejected
                      ? '⚠️ 发生过修订'
                      : '执行中'}
                  </span>

                  {/* 分支人工验收状态 */}
                  {branch.humanReviewRequired && (
                    <span className={`branch-human-pill ${branch.humanReviewStatus ?? 'pending'}`}>
                      {branch.humanReviewStatus === 'approved'
                        ? '✓ 人工已验收'
                        : branch.humanReviewStatus === 'rejected'
                        ? '✕ 人工驳回'
                        : '待人工验收'}
                    </span>
                  )}
                </div>

                {/* 分支干预控制条 */}
                <div className="branch-actions-row">
                  {currentUser?.role === 'admin' && onPauseBranch && onResumeBranch && (
                    branch.isBranchPaused ? (
                      <button
                        type="button"
                        className="branch-action-btn resume"
                        disabled={!canWrite || Boolean(workingAction)}
                        onClick={() => onResumeBranch(branch.workUnitId)}
                      >
                        ▶ 恢复分支
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="branch-action-btn pause"
                        disabled={!canWrite || Boolean(workingAction) || branch.isApproved}
                        onClick={() => onPauseBranch(branch.workUnitId)}
                      >
                        ⏸ 暂停分支
                      </button>
                    )
                  )}

                  {onToggleBranchReviewPolicy && canWrite && (
                    <button
                      type="button"
                      className={`branch-action-btn policy ${branch.humanReviewRequired ? 'active' : ''}`}
                      disabled={Boolean(workingAction) || branch.isApproved}
                      onClick={() => onToggleBranchReviewPolicy(branch.workUnitId, !branch.humanReviewRequired)}
                      title="切换此分支是否需要人工最终确认验收"
                    >
                      {branch.humanReviewRequired ? '需人工验收' : '免人工验收'}
                    </button>
                  )}
                </div>
              </div>

              <div className="branch-steps-chain">
                {branch.steps.map((step, stepIndex) => {
                  const exec = step.task
                  const rev = step.reviewerTask
                  const isSuperseded = step.isSuperseded

                  return (
                    <div
                      className={`branch-step-group ${isSuperseded ? 'superseded' : ''}`}
                      key={exec.taskId}
                    >
                      {/* 执行节点 */}
                      <div className={`step-node executor-node ${exec.status} ${isSuperseded ? 'dimmed' : ''}`}>
                        <div className="step-header">
                          <span className="node-role-tag executor">
                            {exec.stage === 'revision' ? '修订执行' : '执行 Agent'}
                          </span>
                          <strong className="step-agent-name">{step.displayAgent.name}</strong>
                          {isSuperseded && (
                            <span className="superseded-badge">首稿 (已废弃/已修订)</span>
                          )}
                          <span className={`node-model-tag ${step.displayModel.isHighCost ? 'high-cost' : ''}`}>
                            {step.displayModel.fullLabel}
                          </span>
                        </div>
                        <div className="step-body">
                          <p>
                            {exec.submission?.brief ||
                              exec.taskSpec?.title ||
                              exec.input.slice(0, 80)}
                          </p>
                        </div>
                        {currentUser?.role === 'admin' && activeTaskStatuses.has(exec.status) && (
                          <button
                            type="button"
                            className="dag-cancel-btn"
                            disabled={!canWrite || Boolean(workingAction)}
                            onClick={() => onCancelTask(exec)}
                          >
                            取消
                          </button>
                        )}
                      </div>

                      {/* 审核节点（位于对应 Executor 正下方） */}
                      {rev && (
                        <>
                          <div className="inner-arrow">↓ 交付审核</div>
                          <div
                            className={`step-node reviewer-node ${
                              rev.submission?.verdict === 'rejected'
                                ? 'rejected'
                                : rev.submission?.verdict === 'approved'
                                ? 'approved'
                                : rev.status
                            } ${isSuperseded ? 'dimmed' : ''}`}
                          >
                            <div className="step-header">
                              <span className="node-role-tag reviewer">审核 Agent</span>
                              <strong className="step-agent-name">
                                {step.reviewerDisplayAgent?.name ?? '审核员'}
                              </strong>
                              <span
                                className={`node-model-tag ${
                                  step.reviewerDisplayModel?.isHighCost ? 'high-cost' : ''
                                }`}
                              >
                                {step.reviewerDisplayModel?.fullLabel}
                              </span>
                              <span
                                className={`verdict-pill ${
                                  rev.submission?.verdict === 'approved'
                                    ? 'approved'
                                    : rev.submission?.verdict === 'rejected'
                                    ? 'rejected'
                                    : 'pending'
                                }`}
                              >
                                {rev.submission?.verdict === 'approved'
                                  ? '✓ 审核通过'
                                  : rev.submission?.verdict === 'rejected'
                                  ? '✕ 审核拒绝'
                                  : '审核中'}
                              </span>
                            </div>
                            <div className="step-body">
                              <p>{rev.submission?.brief || rev.input}</p>
                              {rev.submission?.issues && rev.submission.issues.length > 0 && (
                                <ul className="verdict-issues">
                                  {rev.submission.issues.map((issueText, idx) => (
                                    <li key={idx}>{issueText}</li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          </div>
                        </>
                      )}

                      {/* 如果有后续修订步，展示向下修订指示 */}
                      {stepIndex < branch.steps.length - 1 && (
                        <div className="revision-transition">
                          <span className="revision-arrow">↓ 要求原 Agent 修订首稿</span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {/* 4. 汇合层：所有分支汇聚到单一 Planner result_intake */}
        {graph.intakeTask && (
          <>
            <div className="dag-connector fan-in">
              <span className="connector-line" />
              <span className="connector-badge">
                ↓ 全部分支通过审核 · 汇合 {graph.approvedResultCount} 个已批准成果
              </span>
            </div>

            <div className={`dag-node intake-node ${graph.intakeTask.status}`}>
              <div className="dag-node-header">
                <span className="node-role-tag planner">成果汇总闭环</span>
                <strong className="node-agent-name">
                  {graph.intakeDisplayAgent?.name ?? '主机 Codex'}
                </strong>
                <span
                  className={`node-model-tag ${
                    graph.intakeDisplayModel?.isHighCost ? 'high-cost' : ''
                  }`}
                >
                  {graph.intakeDisplayModel?.fullLabel}
                </span>
                <span className={`node-status-pill ${graph.intakeTask.status}`}>
                  {graph.intakeTask.status === 'completed'
                    ? graph.finalReviewTask
                      ? '汇总完成 · 提交终审'
                      : '汇总完成 · 任务结案'
                    : '正在汇总'}
                </span>
              </div>
              <div className="dag-node-body">
                <p>
                  {graph.intakeTask.submission?.brief ||
                    `接收来自 ${graph.approvedResultCount} 个工作单元的已核验成果，确认闭环并提交审核。`}
                </p>
              </div>
            </div>
          </>
        )}

        {/* 5. 终审层：第 5 阶段 final_review 最终聚合成果 AI 终审与人工验收 */}
        {graph.finalReviewTask && (
          <>
            <div className="dag-connector">
              <span className="connector-line" />
              <span className="connector-badge">
                ↓ 第 5 阶段 · 最终聚合成果 AI 终审
              </span>
            </div>

            <div className={`dag-node final-review-node ${graph.finalReviewTask.status}`}>
              <div className="dag-node-header">
                <span className="node-role-tag final-reviewer">最终 AI 审核</span>
                <strong className="node-agent-name">
                  {graph.finalReviewDisplayAgent?.name ?? '主机 Codex'}
                </strong>
                <span
                  className={`node-model-tag ${
                    graph.finalReviewDisplayModel?.isHighCost ? 'high-cost' : ''
                  }`}
                >
                  {graph.finalReviewDisplayModel?.fullLabel}
                </span>
                <span
                  className={`node-status-pill ${
                    graph.finalReviewStatus === 'approved'
                      ? 'approved'
                      : graph.finalReviewStatus === 'rejected'
                      ? 'rejected'
                      : 'running'
                  }`}
                >
                  {graph.finalReviewStatus === 'approved'
                    ? '✓ AI 终审通过'
                    : graph.finalReviewStatus === 'rejected'
                    ? '✕ AI 终审驳回'
                    : '正在终审'}
                </span>
              </div>
              <div className="dag-node-body">
                <p>
                  {graph.finalReviewTask.submission?.brief ||
                    graph.intakeTask?.finalReviewBrief ||
                    '独立审核 Planner 汇总后的最终聚合成果，确保满足全流程验收标准。'}
                </p>
              </div>

              {/* 最终人工验收门禁条 */}
              <div className="final-acceptance-bar">
                <div className="acceptance-label-col">
                  <strong>最终人工验收门禁：</strong>
                  <span
                    className={`acceptance-status-tag ${
                      graph.finalHumanReviewStatus ?? 'not_required'
                    }`}
                  >
                    {graph.finalHumanReviewStatus === 'approved'
                      ? '✓ 人工验收已通过'
                      : graph.finalHumanReviewStatus === 'pending'
                      ? '⏳ 等待人工验收决定'
                      : graph.finalHumanReviewStatus === 'rejected'
                      ? '✕ 人工验收已驳回'
                      : '免人工验收（AI 终审通过即放行）'}
                  </span>
                </div>
                {onToggleWorkflowReviewPolicy && canWrite && (
                  <button
                    type="button"
                    className={`final-policy-btn ${
                      graph.finalHumanReviewRequired ? 'required' : ''
                    }`}
                    disabled={Boolean(workingAction) || graph.isFullyCompleted}
                    onClick={() =>
                      onToggleWorkflowReviewPolicy(!graph.finalHumanReviewRequired)
                    }
                  >
                    {graph.finalHumanReviewRequired ? '已开启人工门禁' : '已关闭人工门禁'}
                  </button>
                )}
              </div>

              {/* 全流程结案指示 */}
              {graph.isFullyCompleted && (
                <div className="workflow-completed-banner">
                  <span className="banner-icon">✅</span>
                  <div>
                    <strong>五阶段全流程审核闭环达成 · 任务正式结案</strong>
                    <p>
                      全部分支完成独立审核，Planner 汇总完成，AI 终审通过，且人工验收门禁满足。
                    </p>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* 向下兼容：对于无第 5 阶段的历史四阶段任务展示结案标 */}
        {graph.isConverged && !graph.finalReviewTask && (
          <div className="workflow-completed-banner legacy">
            <span className="banner-icon">✅</span>
            <div>
              <strong>汇总闭环完成 · 任务结案</strong>
              <p>所有分支已通过独立审核，Planner 已完成汇合收敛。</p>
            </div>
          </div>
        )}

        {/* 技术详情折叠区 */}
        <div className="dag-footer-details">
          <TechnicalDetails
            title="查看完整工作流步骤原始参数与任务 ID"
            summaryText={`共 ${tasks.length} 个步骤节点 · 方案版本 rev.${graph.planRevision}`}
            data={{
              branches: graph.branches.map((b) => ({
                workUnitId: b.workUnitId,
                title: b.title,
                stepCount: b.steps.length,
                isApproved: b.isApproved,
                isPaused: b.isBranchPaused,
                humanReviewRequired: b.humanReviewRequired,
                humanReviewStatus: b.humanReviewStatus,
                taskIds: b.steps.map((s) => ({
                  executor: s.task.taskId,
                  reviewer: s.reviewerTask?.taskId,
                })),
              })),
              planningTaskId: graph.planningTask?.taskId,
              intakeTaskId: graph.intakeTask?.taskId,
              finalReviewTaskId: graph.finalReviewTask?.taskId,
              finalReviewStatus: graph.finalReviewStatus,
              finalHumanReviewStatus: graph.finalHumanReviewStatus,
              isFullyCompleted: graph.isFullyCompleted,
            }}
          />
        </div>
      </div>
    </section>
  )
}
