import { useState, useRef } from 'react'
import type { Agent, HubTask, WebUser } from '../types'
import {
  buildWorkflowGraph,
  resolveTaskAgentInfo,
  resolveTaskModelInfo,
} from '../workflow-view-model'
import { TechnicalDetails } from './TechnicalDetails'

interface WorkflowFlowchartProps {
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
  selectedTaskId?: string | null
  onSelectTask?: (task: HubTask) => void
}

export function WorkflowFlowchart({
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
  selectedTaskId,
  onSelectTask,
}: WorkflowFlowchartProps) {
  const graph = buildWorkflowGraph(tasks, agents)
  const [activeInspectorTask, setActiveInspectorTask] = useState<HubTask | null>(null)
  const [laneLayout, setLaneLayout] = useState<'columns' | 'rows'>('columns')
  const [focusedBranchIndex, setFocusedBranchIndex] = useState<number | 'all'>('all')
  const lanesTrackRef = useRef<HTMLDivElement>(null)

  if (tasks.length === 0) {
    return <div className="flowchart-empty">尚未加载步骤数据</div>
  }

  const handleNodeClick = (task: HubTask) => {
    setActiveInspectorTask(task)
    onSelectTask?.(task)
  }

  // 计算当前高亮的选中任务（外部选中或内部点击）
  const inspectedTask =
    activeInspectorTask ??
    (selectedTaskId ? tasks.find((t) => t.taskId === selectedTaskId) : null) ??
    graph.finalReviewTask ??
    graph.intakeTask ??
    graph.planningTask ??
    null

  return (
    <div className="flowchart-container" aria-label="全流程协作流程图">
      {/* 流程图头部图例与状态标 */}
      <div className="flowchart-header">
        <div className="flowchart-title-area">
          <span className="flowchart-icon">🔀</span>
          <h2 className="flowchart-title">协作流程全景流水线</h2>
          <span className="flowchart-mode-pill">
            {graph.totalBranches > 1 ? `${graph.totalBranches} 路并行泳道` : '单线流水线'}
          </span>
          {graph.isWorkflowPaused && (
            <span className="fc-status-pill paused">⏸ 流程已暂停</span>
          )}
          {graph.planningHold && (
            <span className="fc-status-pill hold">🔄 规划屏障中</span>
          )}
        </div>
        <div className="flowchart-legend">
          <span className="legend-item"><i className="legend-dot planner" />规划</span>
          <span className="legend-item"><i className="legend-dot executor" />执行</span>
          <span className="legend-item"><i className="legend-dot reviewer" />审核</span>
          <span className="legend-item"><i className="legend-dot final-review" />AI 终审</span>
          <span className="legend-item"><i className="legend-dot gate" />人工门禁</span>
        </div>
      </div>

      {/* 流程图画板主体 */}
      <div className="flowchart-canvas">
        {/* ========================================================
            阶段 1: 业务需求起点 (Start Node)
            ======================================================== */}
        <div className="fc-stage-block stage-start">
          <div className="fc-stage-label">
            <span className="stage-num">01</span>
            <span className="stage-name">业务需求输入</span>
          </div>

          <div className="fc-node terminal-node start">
            <div className="fc-node-glow" />
            <div className="fc-node-body">
              <div className="fc-node-icon">🎯</div>
              <div className="fc-node-meta">
                <span className="fc-node-role">发起人 · 人类需求</span>
                <strong className="fc-node-title">
                  {graph.planningTask?.input ? '人工需求已下发' : '初始化'}
                </strong>
                <p className="fc-node-desc">
                  {graph.planningTask?.input?.slice(0, 75) || '协作目标输入'}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* 流程连接线：起点 ➔ 规划 */}
        <div className="fc-connector-line">
          <svg className="fc-arrow-svg" height="28" width="100%">
            <line x1="50%" y1="0" x2="50%" y2="28" stroke="#cbd5e1" strokeWidth="2" strokeDasharray="3 3" />
            <polygon points="50,28 46,20 54,20" fill="#94a3b8" transform="translate(0, 0)" />
          </svg>
        </div>

        {/* ========================================================
            阶段 2: 方案规划 (Planner Node)
            ======================================================== */}
        {graph.planningTask && (
          <div className="fc-stage-block stage-planning">
            <div className="fc-stage-label">
              <span className="stage-num">02</span>
              <span className="stage-name">任务方案规划 (Planner)</span>
            </div>

            <div
              className={`fc-node process-node planner-node ${graph.planningTask.status} ${
                inspectedTask?.taskId === graph.planningTask.taskId ? 'selected' : ''
              }`}
              onClick={() => handleNodeClick(graph.planningTask!)}
            >
              <div className="fc-node-header">
                <span className="fc-role-badge planner">规划 Agent</span>
                <strong className="fc-agent-name">
                  {graph.planningDisplayAgent?.name ?? '主机 Codex'}
                </strong>
                <span
                  className={`fc-model-badge ${
                    graph.planningDisplayModel?.isHighCost ? 'high-cost' : ''
                  }`}
                >
                  {graph.planningDisplayModel?.fullLabel}
                </span>
                <span className={`fc-status-tag ${graph.planningTask.status}`}>
                  {graph.planningTask.status === 'completed'
                    ? '✓ 方案生成完毕'
                    : graph.planningTask.status === 'running'
                    ? '⏳ 正在规划'
                    : graph.planningTask.status}
                </span>
              </div>
              <div className="fc-node-content">
                <p>
                  {graph.planningTask.submission?.brief ||
                    graph.planningTask.taskSpec?.title ||
                    graph.planningTask.input}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* 流程分流指示器 (Fork Connector) */}
        {graph.branches.length > 0 && (
          <div className="fc-fork-container">
            <div className="fc-fork-badge">
              <span className="fork-icon">⑂</span>
              <span>并发派发 {graph.branches.length} 个独立执行分支 (Fork)</span>
            </div>

            {/* 分支布局模式切换与快速导航工具条 */}
            <div className="fc-fork-toolbar">
              <div className="fc-branch-layout-toggle" role="tablist" aria-label="分支排版模式">
                <button
                  type="button"
                  className={`fc-layout-btn ${laneLayout === 'columns' ? 'active' : ''}`}
                  onClick={() => setLaneLayout('columns')}
                  title="并排泳道模式（左至右并列展开）"
                >
                  ◫ 并排泳道
                </button>
                <button
                  type="button"
                  className={`fc-layout-btn ${laneLayout === 'rows' ? 'active' : ''}`}
                  onClick={() => setLaneLayout('rows')}
                  title="层叠流向模式（纵向堆叠，横向流转，适合多分支与窄屏）"
                >
                  ☰ 层叠流向
                </button>
              </div>

              {graph.branches.length > 1 && (
                <div className="fc-branch-nav-chips">
                  <button
                    type="button"
                    className={`fc-branch-chip ${focusedBranchIndex === 'all' ? 'active' : ''}`}
                    onClick={() => setFocusedBranchIndex('all')}
                  >
                    全景并排 ({graph.branches.length})
                  </button>
                  {graph.branches.map((b, bIdx) => (
                    <button
                      type="button"
                      className={`fc-branch-chip ${
                        focusedBranchIndex === bIdx ? 'active' : ''
                      } ${b.isApproved ? 'approved' : b.isRejected ? 'rejected' : ''}`}
                      key={b.workUnitId || bIdx}
                      onClick={() => setFocusedBranchIndex(bIdx)}
                      title={b.title}
                    >
                      分支 {bIdx + 1} {b.isApproved ? '✓' : b.isRejected ? '↩' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="fc-fork-branch-lines" />
          </div>
        )}

        {/* 单分支聚焦模式提示横幅 */}
        {focusedBranchIndex !== 'all' && (
          <div className="fc-focus-banner">
            <span>
              🔍 <strong>当前仅聚焦查看 分支 {(focusedBranchIndex as number) + 1}</strong>：
              {graph.branches[focusedBranchIndex as number]?.title}
            </span>
            <button
              type="button"
              className="fc-focus-reset-btn"
              onClick={() => setFocusedBranchIndex('all')}
            >
              返回全景并排 ✕
            </button>
          </div>
        )}

        {/* ========================================================
            阶段 3: 并行执行与审核泳道 (Parallel Lanes)
            支持：
            - 并排泳道 (Columns Mode) 自适应横向滑动轨道与纵向均匀分布
            - 层叠流向 (Rows Mode) 突破宽度限制的多分支水平管线
            ======================================================== */}
        {(() => {
          const displayedBranches =
            focusedBranchIndex === 'all'
              ? graph.branches
              : graph.branches.filter((_, idx) => idx === focusedBranchIndex)

          return laneLayout === 'columns' ? (
            <div className="fc-parallel-lanes-wrapper" ref={lanesTrackRef}>
              <div
                className={`fc-parallel-lanes-grid ${
                  displayedBranches.length === 1
                    ? 'single-branch'
                    : displayedBranches.length === 2
                    ? 'two-branches'
                    : 'multi-branches'
                }`}
              >
                {displayedBranches.map((branch, branchIndex) => {
                  const originalIndex =
                    focusedBranchIndex === 'all' ? branchIndex : (focusedBranchIndex as number)

                  return (
                    <div
                      className={`fc-branch-lane ${branch.isApproved ? 'approved' : ''} ${
                        branch.isRejected ? 'has-rejection' : ''
                      } ${branch.isBranchPaused ? 'paused' : ''} ${
                        branch.steps.length === 1 ? 'single-round' : 'multi-round'
                      }`}
                      key={branch.workUnitId || branchIndex}
                    >
                      {/* 分支泳道头部 */}
                      <div className="fc-lane-header">
                        <div className="fc-lane-title-row">
                          <span className="fc-lane-badge">分支 {originalIndex + 1}</span>
                          <strong className="fc-lane-title" title={branch.title}>
                            {branch.title}
                          </strong>
                          {branch.isBranchPaused && (
                            <span className="fc-pill-badge paused">⏸ 已暂停</span>
                          )}
                        </div>

                        <div className="fc-lane-sub-row">
                          <span
                            className={`fc-pill-badge status ${
                              branch.isApproved
                                ? 'approved'
                                : branch.isRejected
                                ? 'rejected'
                                : 'running'
                            }`}
                          >
                            {branch.isApproved
                              ? '✓ 独立审核已通过'
                              : branch.isRejected
                              ? '⚠️ 经历过修订'
                              : '⏳ 执行中'}
                          </span>

                          {branch.humanReviewRequired && (
                            <span
                              className={`fc-pill-badge human ${branch.humanReviewStatus ?? 'pending'}`}
                            >
                              {branch.humanReviewStatus === 'approved'
                                ? '✓ 人工已验收'
                                : branch.humanReviewStatus === 'rejected'
                                ? '✕ 人工驳回'
                                : '⏳ 待人工验收'}
                            </span>
                          )}
                        </div>

                        {/* 分支控制按钮行 */}
                        <div className="fc-lane-controls">
                          {currentUser?.role === 'admin' && onPauseBranch && onResumeBranch && (
                            branch.isBranchPaused ? (
                              <button
                                type="button"
                                className="fc-ctrl-btn resume"
                                disabled={!canWrite || Boolean(workingAction)}
                                onClick={() => onResumeBranch(branch.workUnitId)}
                              >
                                ▶ 恢复分支
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="fc-ctrl-btn pause"
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
                              className={`fc-ctrl-btn policy ${
                                branch.humanReviewRequired ? 'active' : ''
                              }`}
                              disabled={Boolean(workingAction) || branch.isApproved}
                              onClick={() =>
                                onToggleBranchReviewPolicy(branch.workUnitId, !branch.humanReviewRequired)
                              }
                              title="切换此分支是否需人工确认验收"
                            >
                              {branch.humanReviewRequired ? '需人工验收' : '免人工验收'}
                            </button>
                          )}
                        </div>
                      </div>

                      {/* 泳道内部顺序执行流水线（弹性自适应高度与均匀分布） */}
                      <div className="fc-lane-steps">
                        {branch.steps.map((step, stepIndex) => {
                          const exec = step.task
                          const rev = step.reviewerTask
                          const isSuperseded = step.isSuperseded

                          return (
                            <div
                              className={`fc-step-pair ${isSuperseded ? 'superseded' : ''}`}
                              key={exec.taskId}
                            >
                              {/* 执行节点 (Executor Node) */}
                              <div
                                className={`fc-node step-node executor ${exec.status} ${
                                  inspectedTask?.taskId === exec.taskId ? 'selected' : ''
                                }`}
                                onClick={() => handleNodeClick(exec)}
                              >
                                <div className="fc-step-header">
                                  <span className="fc-role-badge executor">
                                    {exec.stage === 'revision' ? '修订执行' : '执行 Agent'}
                                  </span>
                                  <strong className="fc-agent-name">{step.displayAgent.name}</strong>
                                  {isSuperseded && (
                                    <span className="fc-superseded-tag">首稿 (已被替代)</span>
                                  )}
                                  <span
                                    className={`fc-model-badge ${
                                      step.displayModel.isHighCost ? 'high-cost' : ''
                                    }`}
                                  >
                                    {step.displayModel.fullLabel}
                                  </span>
                                </div>
                                <p className="fc-step-desc">
                                  {exec.submission?.brief || exec.taskSpec?.title || exec.input.slice(0, 70)}
                                </p>
                                {currentUser?.role === 'admin' && activeTaskStatuses.has(exec.status) && (
                                  <button
                                    type="button"
                                    className="fc-cancel-task-btn"
                                    disabled={!canWrite || Boolean(workingAction)}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      onCancelTask(exec)
                                    }}
                                  >
                                    取消此步骤
                                  </button>
                                )}
                              </div>

                              {/* 审核节点 (Reviewer Node) 与自适应纵向连接线 */}
                              {rev && (
                                <>
                                  <div className="fc-step-arrow">
                                    <span>↓ 交付成果复核</span>
                                  </div>
                                  <div
                                    className={`fc-node step-node reviewer ${
                                      rev.submission?.verdict === 'approved'
                                        ? 'approved'
                                        : rev.submission?.verdict === 'rejected'
                                        ? 'rejected'
                                        : rev.status
                                    } ${inspectedTask?.taskId === rev.taskId ? 'selected' : ''}`}
                                    onClick={() => handleNodeClick(rev)}
                                  >
                                    <div className="fc-step-header">
                                      <span className="fc-role-badge reviewer">独立审核</span>
                                      <strong className="fc-agent-name">
                                        {step.reviewerDisplayAgent?.name ?? '审核员'}
                                      </strong>
                                      <span
                                        className={`fc-model-badge ${
                                          step.reviewerDisplayModel?.isHighCost ? 'high-cost' : ''
                                        }`}
                                      >
                                        {step.reviewerDisplayModel?.fullLabel}
                                      </span>
                                      <span
                                        className={`fc-verdict-pill ${
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
                                          ? '✕ 审核驳回'
                                          : '审核中'}
                                      </span>
                                    </div>
                                    <p className="fc-step-desc">{rev.submission?.brief || rev.input}</p>
                                    {rev.submission?.issues && rev.submission.issues.length > 0 && (
                                      <ul className="fc-step-issues">
                                        {rev.submission.issues.map((text, idx) => (
                                          <li key={idx}>{text}</li>
                                        ))}
                                      </ul>
                                    )}
                                  </div>
                                </>
                              )}

                              {/* 修订演进过渡指示 */}
                              {stepIndex < branch.steps.length - 1 && (
                                <div className="fc-revision-transition">
                                  <span className="fc-revision-badge">
                                    ↩ 审核未达标 · 要求原 Agent 修订首稿 (v{stepIndex + 2})
                                  </span>
                                </div>
                              )}
                            </div>
                          )
                        })}

                        {/* 单轮直接通过的分支：自适应填充等高连接线并标示就绪状态，消除大量空白 */}
                        {branch.isApproved && branch.steps.length === 1 && (
                          <div className="fc-lane-wait-connector">
                            <div className="fc-wait-line" />
                            <span className="fc-wait-badge">
                              ✓ 分支已核验就绪 · 待汇合
                            </span>
                            <div className="fc-wait-line" />
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            /* 层叠流向模式 (Rows Mode)：突破屏幕宽度限制，纵向堆叠、横向流转 */
            <div className="fc-parallel-lanes-rows">
              {displayedBranches.map((branch, branchIndex) => {
                const originalIndex =
                  focusedBranchIndex === 'all' ? branchIndex : (focusedBranchIndex as number)

                return (
                  <div
                    className={`fc-branch-row-card ${branch.isApproved ? 'approved' : ''} ${
                      branch.isRejected ? 'has-rejection' : ''
                    } ${branch.isBranchPaused ? 'paused' : ''}`}
                    key={branch.workUnitId || branchIndex}
                  >
                    <div className="fc-row-card-header">
                      <div className="fc-row-title-area">
                        <span className="fc-lane-badge">分支 {originalIndex + 1}</span>
                        <strong className="fc-lane-title">{branch.title}</strong>
                        <span
                          className={`fc-pill-badge status ${
                            branch.isApproved
                              ? 'approved'
                              : branch.isRejected
                              ? 'rejected'
                              : 'running'
                          }`}
                        >
                          {branch.isApproved
                            ? '✓ 独立审核已通过'
                            : branch.isRejected
                            ? '⚠️ 经历过修订'
                            : '⏳ 执行中'}
                        </span>
                        {branch.isBranchPaused && (
                          <span className="fc-pill-badge paused">⏸ 已暂停</span>
                        )}
                        {branch.humanReviewRequired && (
                          <span className={`fc-pill-badge human ${branch.humanReviewStatus ?? 'pending'}`}>
                            {branch.humanReviewStatus === 'approved' ? '✓ 人工已验收' : '⏳ 待人工验收'}
                          </span>
                        )}
                      </div>

                      <div className="fc-lane-controls">
                        {currentUser?.role === 'admin' && onPauseBranch && onResumeBranch && (
                          branch.isBranchPaused ? (
                            <button
                              type="button"
                              className="fc-ctrl-btn resume"
                              disabled={!canWrite || Boolean(workingAction)}
                              onClick={() => onResumeBranch(branch.workUnitId)}
                            >
                              ▶ 恢复分支
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="fc-ctrl-btn pause"
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
                            className={`fc-ctrl-btn policy ${
                              branch.humanReviewRequired ? 'active' : ''
                            }`}
                            disabled={Boolean(workingAction) || branch.isApproved}
                            onClick={() =>
                              onToggleBranchReviewPolicy(branch.workUnitId, !branch.humanReviewRequired)
                            }
                            title="切换此分支是否需人工确认验收"
                          >
                            {branch.humanReviewRequired ? '需人工验收' : '免人工验收'}
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="fc-row-pipeline">
                      {branch.steps.map((step, stepIndex) => {
                        const exec = step.task
                        const rev = step.reviewerTask
                        const isSuperseded = step.isSuperseded

                        return (
                          <div
                            className={`fc-row-step-group ${isSuperseded ? 'superseded' : ''}`}
                            key={exec.taskId}
                          >
                            <div
                              className={`fc-node step-node executor ${exec.status} ${
                                inspectedTask?.taskId === exec.taskId ? 'selected' : ''
                              }`}
                              onClick={() => handleNodeClick(exec)}
                            >
                              <div className="fc-step-header">
                                <span className="fc-role-badge executor">
                                  {exec.stage === 'revision' ? '修订执行' : '执行 Agent'}
                                </span>
                                <strong className="fc-agent-name">{step.displayAgent.name}</strong>
                                {isSuperseded && (
                                  <span className="fc-superseded-tag">首稿 (已被替代)</span>
                                )}
                                <span
                                  className={`fc-model-badge ${
                                    step.displayModel.isHighCost ? 'high-cost' : ''
                                  }`}
                                >
                                  {step.displayModel.fullLabel}
                                </span>
                              </div>
                              <p className="fc-step-desc">
                                {exec.submission?.brief || exec.taskSpec?.title || exec.input.slice(0, 70)}
                              </p>
                            </div>

                            {rev && (
                              <>
                                <div className="fc-row-arrow">➔ 成果复核</div>
                                <div
                                  className={`fc-node step-node reviewer ${
                                    rev.submission?.verdict === 'approved'
                                      ? 'approved'
                                      : rev.submission?.verdict === 'rejected'
                                      ? 'rejected'
                                      : rev.status
                                  } ${inspectedTask?.taskId === rev.taskId ? 'selected' : ''}`}
                                  onClick={() => handleNodeClick(rev)}
                                >
                                  <div className="fc-step-header">
                                    <span className="fc-role-badge reviewer">独立审核</span>
                                    <strong className="fc-agent-name">
                                      {step.reviewerDisplayAgent?.name ?? '审核员'}
                                    </strong>
                                    <span
                                      className={`fc-model-badge ${
                                        step.reviewerDisplayModel?.isHighCost ? 'high-cost' : ''
                                      }`}
                                    >
                                      {step.reviewerDisplayModel?.fullLabel}
                                    </span>
                                    <span
                                      className={`fc-verdict-pill ${
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
                                        ? '✕ 审核驳回'
                                        : '审核中'}
                                    </span>
                                  </div>
                                  <p className="fc-step-desc">{rev.submission?.brief || rev.input}</p>
                                  {rev.submission?.issues && rev.submission.issues.length > 0 && (
                                    <ul className="fc-step-issues">
                                      {rev.submission.issues.map((text, idx) => (
                                        <li key={idx}>{text}</li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                              </>
                            )}

                            {stepIndex < branch.steps.length - 1 && (
                              <div className="fc-row-revision-arrow">
                                <span>↩ 审核未达标 · 要求原 Agent 修订首稿 (v{stepIndex + 2}) ➔</span>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })()}

        {/* 流程合流指示器 (Join Connector) */}
        {graph.intakeTask && (
          <div className="fc-join-container">
            <div className="fc-join-branch-lines" />
            <div className="fc-join-badge">
              <span className="join-icon">⑃</span>
              <span>
                全部分支独立审核完成 · 合流 {graph.approvedResultCount} 项已核验成果 (Merge)
              </span>
            </div>
          </div>
        )}

        {/* ========================================================
            阶段 4: 成果汇总闭环 (Result Intake Node)
            ======================================================== */}
        {graph.intakeTask && (
          <div className="fc-stage-block stage-intake">
            <div className="fc-stage-label">
              <span className="stage-num">04</span>
              <span className="stage-name">成果汇总与方案闭环 (Planner)</span>
            </div>

            <div
              className={`fc-node process-node intake-node ${graph.intakeTask.status} ${
                inspectedTask?.taskId === graph.intakeTask.taskId ? 'selected' : ''
              }`}
              onClick={() => handleNodeClick(graph.intakeTask!)}
            >
              <div className="fc-node-header">
                <span className="fc-role-badge planner">成果汇总闭环</span>
                <strong className="fc-agent-name">
                  {graph.intakeDisplayAgent?.name ?? '主机 Codex'}
                </strong>
                <span
                  className={`fc-model-badge ${
                    graph.intakeDisplayModel?.isHighCost ? 'high-cost' : ''
                  }`}
                >
                  {graph.intakeDisplayModel?.fullLabel}
                </span>
                <span className={`fc-status-tag ${graph.intakeTask.status}`}>
                  {graph.intakeTask.status === 'completed'
                    ? graph.finalReviewTask
                      ? '✓ 成果汇合完毕 · 送终审'
                      : '✓ 成果汇合完毕 · 任务结案'
                    : '⏳ 正在汇总各分支成果'}
                </span>
              </div>
              <div className="fc-node-content">
                <p>
                  {graph.intakeTask.submission?.brief ||
                    `接收来自 ${graph.approvedResultCount} 个工作单元的已核验成果，确认闭环并提交审核。`}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================
            阶段 5: 最终聚合成果 AI 终审 (Final Review Node)
            ======================================================== */}
        {graph.finalReviewTask && (
          <>
            <div className="fc-connector-line">
              <svg className="fc-arrow-svg" height="28" width="100%">
                <line x1="50%" y1="0" x2="50%" y2="28" stroke="#8b5cf6" strokeWidth="2" />
                <polygon points="50,28 46,20 54,20" fill="#7c3aed" />
              </svg>
            </div>

            <div className="fc-stage-block stage-final-review">
              <div className="fc-stage-label">
                <span className="stage-num">05</span>
                <span className="stage-name">最终独立 AI 终审 (Final Review)</span>
              </div>

              <div
                className={`fc-node process-node final-review-node ${
                  graph.finalReviewStatus ?? 'running'
                } ${inspectedTask?.taskId === graph.finalReviewTask.taskId ? 'selected' : ''}`}
                onClick={() => handleNodeClick(graph.finalReviewTask!)}
              >
                <div className="fc-node-header">
                  <span className="fc-role-badge final-reviewer">最终 AI 终审员</span>
                  <strong className="fc-agent-name">
                    {graph.finalReviewDisplayAgent?.name ?? '主机 Codex'}
                  </strong>
                  <span
                    className={`fc-model-badge ${
                      graph.finalReviewDisplayModel?.isHighCost ? 'high-cost' : ''
                    }`}
                  >
                    {graph.finalReviewDisplayModel?.fullLabel}
                  </span>
                  <span
                    className={`fc-status-tag ${
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
                      : '⏳ 正在终审'}
                  </span>
                </div>
                <div className="fc-node-content">
                  <p>
                    {graph.finalReviewTask.submission?.brief ||
                      graph.intakeTask?.finalReviewBrief ||
                      '独立审核全量汇合后的交付成果，确保业务标准彻底满足。'}
                  </p>
                </div>
              </div>

              {/* 最终人工验收门禁判定盾 (Human Gate) */}
              <div className="fc-gate-card">
                <div className="fc-gate-icon">🛡️</div>
                <div className="fc-gate-body">
                  <div className="fc-gate-title-row">
                    <strong>最终人工验收门禁 (Human Gate)</strong>
                    <span
                      className={`fc-gate-status ${
                        graph.finalHumanReviewStatus ?? 'not_required'
                      }`}
                    >
                      {graph.finalHumanReviewStatus === 'approved'
                        ? '✓ 人工验收已放行'
                        : graph.finalHumanReviewStatus === 'pending'
                        ? '⏳ 等待人工终审决定'
                        : graph.finalHumanReviewStatus === 'rejected'
                        ? '✕ 人工验收已驳回'
                        : '免人工门禁（AI 终审通过即放行）'}
                    </span>
                  </div>
                  <p className="fc-gate-desc">
                    {graph.finalHumanReviewRequired
                      ? '已开启强制人工门禁：系统要求操作人员对最终交付成果进行最终复核放行。'
                      : '当前处于自动放行模式：只要 AI 终审通过，工作流即可自动宣告结案。'}
                  </p>
                </div>
                {onToggleWorkflowReviewPolicy && canWrite && (
                  <button
                    type="button"
                    className={`fc-gate-toggle-btn ${
                      graph.finalHumanReviewRequired ? 'required' : ''
                    }`}
                    disabled={Boolean(workingAction) || graph.isFullyCompleted}
                    onClick={() => onToggleWorkflowReviewPolicy(!graph.finalHumanReviewRequired)}
                  >
                    {graph.finalHumanReviewRequired ? '门禁已开启' : '门禁已关闭'}
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {/* ========================================================
            终点: 全流程结案指示 (Finished Terminal)
            ======================================================== */}
        {graph.isFullyCompleted ? (
          <div className="fc-completed-terminal five-phase">
            <div className="terminal-glow" />
            <span className="terminal-icon">🏆</span>
            <div>
              <strong>五阶段全流程审核闭环达成 · 任务正式结案</strong>
              <p>
                全部分支独立审核通过 ➔ Planner 汇合收敛 ➔ AI 独立终审通过 ➔ 人工门禁验证合格。
              </p>
            </div>
          </div>
        ) : graph.isConverged && !graph.finalReviewTask ? (
          <div className="fc-completed-terminal legacy">
            <span className="terminal-icon">✅</span>
            <div>
              <strong>汇总闭环完成 · 任务结案 (4 阶段模式)</strong>
              <p>各分支已通过独立审核，Planner 已完成汇合收敛。</p>
            </div>
          </div>
        ) : null}
      </div>

      {/* ========================================================
          底部节点详情检查器 (Node Inspector)
          ======================================================== */}
      {inspectedTask && (
        <div className="fc-node-inspector">
          <div className="inspector-header">
            <div className="inspector-title">
              <span className="inspector-tag">选定节点属性</span>
              <strong>{inspectedTask.taskSpec?.title ?? inspectedTask.taskId}</strong>
            </div>
            <span className="inspector-id">Task ID: {inspectedTask.taskId.slice(0, 8)}…</span>
          </div>

          <div className="inspector-grid">
            <div className="inspector-item">
              <span className="inspector-label">角色与阶段</span>
              <span className="inspector-value">
                {inspectedTask.role ?? 'executor'} · {inspectedTask.stage ?? 'execution'}
              </span>
            </div>
            <div className="inspector-item">
              <span className="inspector-label">指派 Agent</span>
              <span className="inspector-value">
                {resolveTaskAgentInfo(inspectedTask, agents).name}
                {resolveTaskAgentInfo(inspectedTask, agents).device && (
                  <small> ({resolveTaskAgentInfo(inspectedTask, agents).device})</small>
                )}
              </span>
            </div>
            <div className="inspector-item">
              <span className="inspector-label">使用模型与强度</span>
              <span className="inspector-value">
                {resolveTaskModelInfo(inspectedTask).fullLabel}
              </span>
            </div>
            <div className="inspector-item">
              <span className="inspector-label">运行状态</span>
              <span className="inspector-value status-highlight">
                {inspectedTask.status}
              </span>
            </div>
          </div>

          {inspectedTask.submission?.issues && inspectedTask.submission.issues.length > 0 && (
            <div className="inspector-issues-box">
              <span className="inspector-label">审核指出问题：</span>
              <ul>
                {inspectedTask.submission.issues.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* 底部折叠完整技术详情 */}
      <div className="fc-footer-details">
        <TechnicalDetails
          title="查看完整工作流原始机器参数"
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
  )
}
