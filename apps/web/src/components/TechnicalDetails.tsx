import { useState } from 'react'

interface TechnicalDetailsProps {
  title?: string
  data?: Record<string, unknown> | null
  summaryText?: string
  children?: React.ReactNode
}

/**
 * 技术详情折叠卡片（默认折叠）
 * 用于放置原始 JSON、任务 ID、Agent ID、错误堆栈等非技术用户无需优先关注的信息
 */
export function TechnicalDetails({
  title = '技术详情',
  data,
  summaryText,
  children,
}: TechnicalDetailsProps) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <details
      className="tech-details"
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary className="tech-details-summary">
        <span className="tech-details-icon">{isOpen ? '▾' : '▸'}</span>
        <span className="tech-details-title">{title}</span>
        {summaryText && <span className="tech-details-hint">{summaryText}</span>}
      </summary>
      <div className="tech-details-body">
        {children}
        {data && (
          <pre className="tech-details-json">
            {JSON.stringify(data, null, 2)}
          </pre>
        )}
      </div>
    </details>
  )
}
