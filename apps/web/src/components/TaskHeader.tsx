import { useState } from 'react'
import type { Agent, Conversation, HubTask, HumanIntervention, WebUser } from '../types'
import { buildWorkflowGraph, deriveWorkflowSummary } from '../workflow-view-model'
import { TechnicalDetails } from './TechnicalDetails'

export type ViewMode = 'split' | 'flowchart' | 'chat'

interface TaskHeaderProps {
  conversation: Conversation
  tasks: HubTask[]
  interventions?: HumanIntervention[]
  agents: Agent[]
  currentUser?: WebUser | null
  canWrite?: boolean
  workingAction?: string
  viewMode?: ViewMode
  onViewModeChange?: (mode: ViewMode) => void
  onFocusIntervention?: () => void
  onPauseWorkflow?: () => void
  onResumeWorkflow?: () => void
  onRequestPlanChange?: (instructions: string) => void
}

export function TaskHeader({
  conversation,
  tasks,
  interventions = [],
  agents,
  canWrite = false,
  workingAction = '',
  viewMode = 'split',
  onViewModeChange,
  onFocusIntervention,
  onPauseWorkflow,
  onResumeWorkflow,
  onRequestPlanChange,
}: TaskHeaderProps) {
  const summary = deriveWorkflowSummary(tasks, conversation, interventions)
  const graph = buildWorkflowGraph(tasks, agents)
  const [planChangeOpen, setPlanChangeOpen] = useState(false)
  const [planInstructions, setPlanInstructions] = useState('')

  const pendingInterventions = interventions.filter(
    (item) => item.status === 'pending' || item.status === 'required',
  )

  const participantAgents = conversation.participants
    .map((id) => agents.find((a) => a.agentId === id))
    .filter((a): a is Agent => Boolean(a))

  const isCompletedOrCancelled =
    conversation.status === 'completed' ||
    conversation.status === 'cancelled' ||
    graph.isFullyCompleted

  return (
    <header className="task-header-card sleek">
      <div className="task-header-main">
        {/* 顶部控制行：状态标签 + 介入按钮 + 工作流干预 + 视图切换器 */}
        <div className="task-title-row">
          <span className={`human-status-badge ${summary.statusTone}`}>
            <i className="status-indicator-dot" />
            {summary.statusText}
          </span>
          <span className="stage-pill">{summary.stageText}</span>

          {graph.isWorkflowPaused && (
            <span className="paused-header-pill">⏸ 工作流已暂停</span>
          )}
          {graph.planningHold && (
            <span className="hold-header-pill">🔄 调整计划屏障中</span>
          )}

          {summary.needsHuman && (
            <button
              type="button"
              className="human-alert-btn"
              onClick={onFocusIntervention}
            >
              ⚠️ 需要你的决定 ({pendingInterventions.length})
            </button>
          )}

          {/* 快捷干预操作按钮组 */}
          {canWrite && !isCompletedOrCancelled && (
            <div className="workflow-quick-actions">
              {graph.isWorkflowPaused ? (
                <button
                  type="button"
                  className="hdr-action-btn resume"
                  disabled={Boolean(workingAction)}
                  onClick={onResumeWorkflow}
                  title="恢复所有分支的调度执行"
                >
                  ▶ 恢复工作流
                </button>
              ) : (
                <button
                  type="button"
                  className="hdr-action-btn pause"
                  disabled={Boolean(workingAction)}
                  onClick={onPauseWorkflow}
                  title="暂停工作流调度"
                >
                  ⏸ 暂停工作流
                </button>
              )}

              <button
                type="button"
                className="hdr-action-btn plan-change"
                disabled={Boolean(workingAction) || graph.planningHold}
                onClick={() => setPlanChangeOpen(true)}
                title="向 Planner 发送指示，调整执行分支或重跑"
              >
                📝 申请调整计划
              </button>
            </div>
          )}

          {/* 视图模式切换器 (分栏 / 全景流程图 / 对话流) */}
          <div className="view-mode-switcher" role="tablist" aria-label="视图模式切换">
            <button
              type="button"
              className={`view-mode-btn ${viewMode === 'split' ? 'active' : ''}`}
              onClick={() => onViewModeChange?.('split')}
              title="左右分栏：左侧流程图与异常监控，右侧对话流与产物"
            >
              ⚡ 分栏协同
            </button>
            <button
              type="button"
              className={`view-mode-btn ${viewMode === 'flowchart' ? 'active' : ''}`}
              onClick={() => onViewModeChange?.('flowchart')}
              title="纯流程图看板：全屏直观呈现全流程流水线"
            >
              🔀 流程图看板
            </button>
            <button
              type="button"
              className={`view-mode-btn ${viewMode === 'chat' ? 'active' : ''}`}
              onClick={() => onViewModeChange?.('chat')}
              title="纯对话流：专注阅读各 Agent 汇报与附件"
            >
              💬 对话成果流
            </button>
          </div>
        </div>

        {/* 第二行：标题与内联指标 */}
        <div className="task-heading-row">
          <h1 className="task-heading">{summary.title}</h1>

          <div className="task-inline-stats">
            <span className="inline-stat-chip">
              <span className="chip-label">分支:</span>
              <strong>{summary.parallelCount} 路并行</strong>
            </span>
            <span className="inline-stat-chip">
              <span className="chip-label">进度:</span>
              <strong>
                {summary.completedStepCount}/{summary.totalStepCount} 步骤
              </strong>
            </span>
            <span className="inline-stat-chip">
              <span className="chip-label">状态:</span>
              <strong>{summary.durationOrCompletionTime || '进行中'}</strong>
            </span>
            {participantAgents.length > 0 && (
              <span className="inline-stat-chip agents">
                <span className="chip-label">Agent:</span>
                <strong>{participantAgents.length} 个</strong>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="task-header-footer compact">
        <TechnicalDetails
          title="系统机器状态与任务 ID"
          summaryText={`ID: ${conversation.rootTaskId.slice(0, 8)}… · 机器状态: ${summary.rawStatus}`}
          data={{
            rootTaskId: conversation.rootTaskId,
            rawStatus: summary.rawStatus,
            taskCount: conversation.taskCount,
            messageCount: conversation.messageCount,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            participants: conversation.participants,
          }}
        />
      </div>

      {/* 申请调整计划模态框 */}
      {planChangeOpen && (
        <div className="plan-change-modal-overlay">
          <div className="plan-change-modal">
            <div className="modal-header">
              <strong>申请调整工作流计划 (Plan Change)</strong>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setPlanChangeOpen(false)}
              >
                ✕
              </button>
            </div>
            <p className="modal-desc">
              向 Planner 发送明确的调整指示（例如增减分支、修改验证要求或重跑）。系统将建立全局规划屏障，由 Planner 重新生成新版本方案。
            </p>
            <textarea
              className="plan-change-textarea"
              rows={4}
              placeholder="请输入具体的计划调整要求，如：增加第三个性能核验分支，并重新执行分支 2..."
              value={planInstructions}
              onChange={(e) => setPlanInstructions(e.target.value)}
            />
            <div className="modal-actions">
              <button
                type="button"
                className="btn-cancel"
                onClick={() => setPlanChangeOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-submit"
                disabled={!planInstructions.trim() || Boolean(workingAction)}
                onClick={() => {
                  onRequestPlanChange?.(planInstructions.trim())
                  setPlanChangeOpen(false)
                  setPlanInstructions('')
                }}
              >
                提交计划变更申请
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  )
}
