/**
 * <StatBadge> 统计徽标
 * 道次计数、荫房超标次数、合格率等派生指标的统一样式；
 * 被荫房页、打磨页、导出页消费。
 */
import type { ReactNode } from 'react';
import { Progress } from 'antd';

export type BadgeTone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface StatBadgeProps {
  label: string;
  value: ReactNode;
  /** 单位或补充说明 */
  suffix?: string;
  /** 0-100 的占比，传入后渲染进度条 */
  percent?: number;
  tone?: BadgeTone;
  icon?: ReactNode;
  size?: 'default' | 'small';
}

const TONE_COLOR: Record<BadgeTone, string> = {
  default: '#8c8479',
  primary: '#2f3a34',
  success: '#2f6f4f',
  warning: '#a8623a',
  danger: '#b03a2e',
  info: '#3a6ea5',
};

export function StatBadge({
  label,
  value,
  suffix,
  percent,
  tone = 'default',
  icon,
  size = 'default',
}: StatBadgeProps) {
  const color = TONE_COLOR[tone];
  return (
    <div className={`gb-stat-badge${size === 'small' ? ' is-small' : ''}`} style={{ borderLeftColor: color }}>
      <div className="gb-stat-badge__head" style={{ color: '#6b6257' }}>
        {icon ? <span style={{ color }}>{icon}</span> : null}
        <span>{label}</span>
      </div>
      <div className="gb-stat-badge__body">
        <span className="gb-stat-badge__value">{value}</span>
        {suffix ? <span className="gb-stat-badge__suffix">{suffix}</span> : null}
      </div>
      {percent === undefined ? null : (
        <Progress
          percent={Math.min(100, Math.max(0, Math.round(percent)))}
          size="small"
          showInfo={false}
          strokeColor={color}
          trailColor="rgba(140,47,31,0.12)"
        />
      )}
    </div>
  );
}

export default StatBadge;
