import type { RefObject } from 'react'
import type { Agent, Conversation, HubMessage, HubTask } from '../types'
import { MessageBubble } from './MessageBubble'

interface ConversationTimelineProps {
  conversation: Conversation
  messages: HubMessage[]
  tasks: HubTask[]
  agents: Agent[]
  loadingMessageIds: Set<string>
  onLoadFullResult: (message: HubMessage) => void
  onDownloadArtifact: (downloadUrl: string, filename: string) => Promise<void>
  chatEndRef: RefObject<HTMLDivElement | null>
}

export function ConversationTimeline({
  conversation,
  messages,
  tasks,
  agents,
  loadingMessageIds,
  onLoadFullResult,
  onDownloadArtifact,
  chatEndRef,
}: ConversationTimelineProps) {
  const taskMap = new Map<string, HubTask>()
  for (const t of tasks) {
    taskMap.set(t.taskId, t)
  }

  return (
    <section className="conversation-timeline" aria-label="任务群聊消息流">
      <div className="chat-date-banner">
        <span>任务创建于 {formatDate(conversation.createdAt)}</span>
      </div>

      <div className="message-list-wrap">
        {messages.map((message) => {
          const task = taskMap.get(message.taskId)
          const isLoading = loadingMessageIds.has(message.messageId)

          return (
            <MessageBubble
              key={message.messageId}
              message={message}
              task={task}
              agents={agents}
              loadingFullResult={isLoading}
              onLoadFullResult={() => onLoadFullResult(message)}
              onDownloadArtifact={onDownloadArtifact}
            />
          )
        })}

        {messages.length === 0 && (
          <div className="empty-timeline-card">
            <span className="empty-timeline-icon">💬</span>
            <strong>尚未产生群聊消息</strong>
            <p>任务开始执行后，规划、执行与审核 Agent 的进度简报将在此展示。</p>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>
    </section>
  )
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}
