import { useState } from 'react'
import type { Agent, HubMessage, HubTask } from '../types'
import {
  formatAgentDisplayName,
  formatModelDisplayName,
  resolveTaskModelInfo,
} from '../workflow-view-model'
import { TechnicalDetails } from './TechnicalDetails'

const roleChineseName: Record<string, string> = {
  planner: '规划 Agent',
  executor: '执行 Agent',
  reviewer: '审核 Agent',
  human: '人类操作者',
  system: '系统调度',
}

interface MessageBubbleProps {
  message: HubMessage
  task?: HubTask
  agents: Agent[]
  loadingFullResult: boolean
  onLoadFullResult: () => void
  onDownloadArtifact: (downloadUrl: string, filename: string) => Promise<void>
}

export function MessageBubble({
  message,
  task,
  agents,
  loadingFullResult,
  onLoadFullResult,
  onDownloadArtifact,
}: MessageBubbleProps) {
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const isStatus = message.kind === 'status'
  const timeFormatted = formatTime(message.createdAt)

  // 1. 系统消息紧凑化展示，不与 Agent 正文争夺视觉空间
  if (isStatus) {
    return (
      <div className="system-compact-message">
        <span className="system-dot" />
        <span className="system-text">{message.text}</span>
        <time className="system-time">{timeFormatted}</time>
      </div>
    )
  }

  // 2. 解析人类友好的 Agent 与模型展示信息
  const agent = agents.find((item) => item.agentId === message.senderId)
  const agentInfo = formatAgentDisplayName(
    message.senderId,
    agent?.deviceId,
    agent?.account,
    agent?.adapter,
  )

  const taskModelInfo = task
    ? resolveTaskModelInfo(task)
    : formatModelDisplayName(null)

  const roleLabel = roleChineseName[message.senderRole] ?? message.senderRole

  return (
    <article
      className={`message-bubble ${message.senderRole}`}
      data-task-id={task?.taskId ?? message.taskId}
      id={`msg-task-${task?.taskId ?? message.taskId}`}
    >
      <div className={`avatar-badge ${message.senderRole}`}>
        {message.senderRole === 'planner'
          ? '规'
          : message.senderRole === 'reviewer'
          ? '审'
          : message.senderRole === 'executor'
          ? '执'
          : message.senderRole === 'human'
          ? '人'
          : '系'}
        {agent && <i className={`status-dot ${agent.status === 'online' ? 'online' : 'offline'}`} />}
      </div>

      <div className="message-main-col">
        <header className="message-header-line">
          <strong className="friendly-sender-name">{agentInfo.name}</strong>
          <span className={`role-badge ${message.senderRole}`}>{roleLabel}</span>
          {agentInfo.device && agentInfo.device !== '系统' && agentInfo.device !== '人工' && (
            <span className="device-chip">{agentInfo.device}</span>
          )}
          {taskModelInfo.fullLabel !== '尚未分配' && (
            <span className={`model-chip ${taskModelInfo.isHighCost ? 'high-cost' : ''}`}>
              {taskModelInfo.fullLabel}
              {taskModelInfo.isHighCost && <em className="high-cost-pill">高消耗</em>}
            </span>
          )}
          <time className="message-timestamp">{timeFormatted}</time>
        </header>

        <div className="message-bubble-content">
          <p className="message-text">{message.text}</p>

          {message.mentions.length > 0 && (
            <div className="message-mentions">
              {message.mentions.map((mention) => (
                <span key={mention} className="mention-tag">
                  {mention.startsWith('@') ? mention : `@${mention}`}
                </span>
              ))}
            </div>
          )}

          {/* 成果附件与按需加载 */}
          {message.attachments.map((attachment, idx) => (
            <details
              className="message-attachment-box"
              key={`${attachment.taskId ?? message.taskId}-${idx}`}
              onToggle={(event) =>
                event.currentTarget.open &&
                attachment.type === 'full_result' &&
                attachment.content === undefined &&
                onLoadFullResult()
              }
            >
              <summary className="attachment-summary">
                <span className="attachment-icon">📦</span>
                <div className="attachment-meta">
                  <strong>{attachment.label}</strong>
                  <small>{attachment.version ?? '完整成果附件'} · 点击展开或按需加载</small>
                </div>
                <span className="attachment-toggle-icon">⌄</span>
              </summary>

              {loadingFullResult &&
                attachment.type === 'full_result' &&
                attachment.content === undefined && (
                  <div className="attachment-loading-hint">正在从 Hub 加载完整成果…</div>
                )}

              {attachment.content !== undefined && (
                <pre className="attachment-pre-content">{attachment.content}</pre>
              )}

              {(attachment.artifacts?.files ?? []).map((file) => (
                <div className="artifact-file-row" key={file.path}>
                  {file.status === 'ready' && file.downloadUrl ? (
                    <button
                      type="button"
                      className="download-artifact-btn"
                      onClick={() =>
                        void onDownloadArtifact(file.downloadUrl!, file.path).catch((err) =>
                          setDownloadError(err instanceof Error ? err.message : '下载失败'),
                        )
                      }
                    >
                      ⬇ {file.path}
                    </button>
                  ) : (
                    <span className="artifact-filename">{file.path}</span>
                  )}
                  <small className="artifact-filesize">
                    {file.status} · {formatBytes(file.size)}
                  </small>
                </div>
              ))}
              {downloadError && <div className="download-error-toast">{downloadError}</div>}
            </details>
          ))}

          {/* Token 指标展示 */}
          {['task_brief', 'review_decision'].includes(message.kind) && (task?.usageTotals || task?.usage) && (
            <div className="message-token-metrics">
              <span>输入 {formatTokens((task.usageTotals ?? task.usage)!.inputTokens)}</span>
              <span>输出 {formatTokens((task.usageTotals ?? task.usage)!.outputTokens)}</span>
              <strong>共 {formatTokens((task.usageTotals ?? task.usage)!.totalTokens)} tokens</strong>
              {task.startedAt && task.completedAt && <span>耗时 {formatDuration(task.startedAt, task.completedAt)}</span>}
            </div>
          )}
        </div>

        {/* 技术详情：默认折叠 */}
        <TechnicalDetails
          title="技术详情"
          summaryText={`ID: ${message.messageId.slice(0, 12)}… · 角色: ${message.senderRole}`}
          data={{
            messageId: message.messageId,
            taskId: message.taskId,
            senderId: message.senderId,
            senderRole: message.senderRole,
            kind: message.kind,
            createdAt: message.createdAt,
            rawModel: task?.model ?? task?.execution?.model ?? null,
            reasoningEffort: task?.execution?.reasoningEffort ?? task?.reasoningEffort ?? null,
            targetAgentId: task?.targetAgentId ?? null,
          }}
        />
      </div>
    </article>
  )
}

function formatTokens(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value)
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function formatDuration(start: string, end: string): string {
  const startTime = Date.parse(start)
  const endTime = Date.parse(end)
  if (!startTime || !endTime || endTime < startTime) return ''
  const seconds = Math.round((endTime - startTime) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder > 0 ? `${minutes}m${remainder}s` : `${minutes}m`
}

function formatBytes(value: number) {
  return value < 1024
    ? `${value} B`
    : value < 1024 * 1024
    ? `${(value / 1024).toFixed(1)} KB`
    : value < 1024 * 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
}
