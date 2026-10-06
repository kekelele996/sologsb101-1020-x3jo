/**
 * <EmptyPanel> 空数据引导与新建入口
 * 被全部列表页消费；层级路由查不到 id 时也用它给出友好空态（不白屏）。
 */
import type { ReactNode } from 'react';
import { Button, Empty, Space, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

export interface EmptyPanelProps {
  title: string;
  description?: ReactNode;
  /** 主操作按钮文案；不传则不渲染 */
  actionText?: string;
  onAction?: () => void;
  /** 次操作按钮（如「返回列表」） */
  secondaryText?: string;
  onSecondary?: () => void;
  /** 附加内容（提示、统计等） */
  extra?: ReactNode;
  size?: 'small' | 'default';
}

export function EmptyPanel({
  title,
  description,
  actionText,
  onAction,
  secondaryText,
  onSecondary,
  extra,
  size = 'default',
}: EmptyPanelProps) {
  return (
    <div className={`gb-empty-panel${size === 'small' ? ' is-small' : ''}`}>
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        imageStyle={{ height: size === 'small' ? 40 : 60 }}
        description={
          <Space direction="vertical" size={4}>
            <Typography.Text strong style={{ fontSize: 16 }}>
              {title}
            </Typography.Text>
            {description ? (
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                {description}
              </Typography.Text>
            ) : null}
          </Space>
        }
      >
        {actionText || secondaryText ? (
          <Space wrap>
            {actionText && onAction ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={onAction}>
                {actionText}
              </Button>
            ) : null}
            {secondaryText && onSecondary ? <Button onClick={onSecondary}>{secondaryText}</Button> : null}
          </Space>
        ) : null}
      </Empty>
      {extra ? <div style={{ marginTop: 12 }}>{extra}</div> : null}
    </div>
  );
}

export default EmptyPanel;
