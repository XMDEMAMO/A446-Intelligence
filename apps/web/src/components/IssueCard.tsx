import type { WorkflowIssue } from '../types'

interface IssueCardProps {
  issue: WorkflowIssue
}

export function IssueCard({ issue }: IssueCardProps) {
  const isResolved = issue.isResolved

  return (
    <article className={`issue-card ${isResolved ? 'resolved' : 'unresolved'}`}>
      <div className="issue-card-header">
        <span className={`issue-status-pill ${isResolved ? 'resolved' : 'unresolved'}`}>
          {isResolved ? '✓ 已恢复解决' : '⚠️ 需关注异常'}
        </span>
        <span className="issue-branch-tag">{issue.affectedBranch}</span>
        <span className="issue-time-role">{issue.agentName}</span>
      </div>

      <div className="issue-content-grid">
        <div className="issue-field">
          <span className="issue-field-label">发生了什么</span>
          <div className="issue-field-value issue-event">{issue.whatHappened}</div>
        </div>

        {issue.details && issue.details.length > 0 && (
          <div className="issue-field">
            <span className="issue-field-label">原因说明</span>
            <ul className="issue-reasons-list">
              {issue.details.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="issue-field">
          <span className="issue-field-label">系统处置</span>
          <div className="issue-field-value">{issue.actionTaken}</div>
        </div>

        <div className="issue-field">
          <span className="issue-field-label">当前结果</span>
          <div className={`issue-field-value ${isResolved ? 'text-success' : 'text-danger'}`}>
            {issue.finalOutcome}
          </div>
        </div>
      </div>
    </article>
  )
}

interface IssuePanelProps {
  issues: WorkflowIssue[]
}

export function IssuePanel({ issues }: IssuePanelProps) {
  if (!issues || issues.length === 0) return null

  const resolvedCount = issues.filter((i) => i.isResolved).length
  const unresolvedCount = issues.length - resolvedCount

  return (
    <section className="issue-panel" aria-label="工作流异常与恢复说明">
      <div className="issue-panel-header">
        <div className="issue-panel-title">
          <strong>工作流异常与恢复记录</strong>
          <span className="issue-count-badge">
            {unresolvedCount > 0 ? `${unresolvedCount} 个待处理 · ` : ''}
            {resolvedCount} 个已解决
          </span>
        </div>
        <small className="issue-panel-hint">
          记录任务运行中发生的审核拒绝、执行错误或自动修订过程
        </small>
      </div>
      <div className="issue-card-list">
        {issues.map((issue) => (
          <IssueCard key={issue.issueId} issue={issue} />
        ))}
      </div>
    </section>
  )
}
