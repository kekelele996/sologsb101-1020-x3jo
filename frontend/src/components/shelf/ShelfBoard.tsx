/**
 * 柜位平面图：柜层 × 固定槽位展示装具摆放。
 * 每层槽位定死（TIER_SLOT_CAPACITY），写库失败挂起的装具仍占槽位。
 */
import { useMemo } from 'react';
import { Empty, Space, Tag, Typography } from 'antd';
import {
  CONTAINER_SIZE_LIMIT_CM,
  CONTAINER_STATUS_COLOR,
  CONTAINER_STATUS_LABEL,
} from '@/types/container';
import { TIER_SLOT_CAPACITY } from '@/types/shelfTier';
import { selectContainersByTier } from '@/stores/shelfSlice';
import { useAppSelector } from '@/stores/store';
import EmptyPanel from '@/components/common/EmptyPanel';

export default function ShelfBoard() {
  const groups = useAppSelector(selectContainersByTier);
  const filledSlots = useMemo(() => groups.reduce((sum, group) => sum + group.containers.length, 0), [groups]);

  if (groups.length === 0) {
    return <EmptyPanel title="还没有柜层" description="首次入库排架时会按槽位自动建柜层。" size="small" />;
  }

  return (
    <div className="gb-shelf-board">
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        每层固定 {TIER_SLOT_CAPACITY} 个装具槽位 · 已占槽位 {filledSlots} 个（含写库失败挂起）
      </Typography.Text>
      <Space direction="vertical" size={10} style={{ width: '100%', marginTop: 8 }}>
        {groups.map(({ tier, label, containers }) => {
          const bySlot = new Map(containers.map((container) => [container.slotNo ?? 0, container]));
          const slots = Array.from({ length: tier.slotCapacity }, (_, index) => index + 1);
          return (
            <div className="gb-shelf-tier" key={tier.id}>
              <div className="gb-shelf-tier__label">
                <strong>{tier.code}</strong>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {label}
                </Typography.Text>
              </div>
              <div className="gb-shelf-tier__slots">
                {slots.map((slotNo) => {
                  const container = bySlot.get(slotNo);
                  if (!container) {
                    return (
                      <div className="gb-shelf-slot is-empty" key={slotNo}>
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`槽 ${slotNo} 空`} />
                      </div>
                    );
                  }
                  const percent = Math.min(100, Math.round((container.usedSizeCm / CONTAINER_SIZE_LIMIT_CM) * 100));
                  return (
                    <div className="gb-shelf-slot" key={slotNo}>
                      <Space direction="vertical" size={2} style={{ width: '100%' }}>
                        <Space size={4} wrap>
                          <Tag color={CONTAINER_STATUS_COLOR[container.status]} style={{ marginInlineEnd: 0 }}>
                            {CONTAINER_STATUS_LABEL[container.status]}
                          </Tag>
                          <strong>{container.code}</strong>
                        </Space>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          槽 {slotNo} · {container.items.length} 件
                        </Typography.Text>
                        <div className="gb-shelf-slot__bar">
                          <div style={{ width: `${percent}%`, background: CONTAINER_STATUS_COLOR[container.status] }} />
                        </div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {container.usedSizeCm}/{CONTAINER_SIZE_LIMIT_CM}cm
                        </Typography.Text>
                        {container.status === 'writeFailed' ? (
                          <Typography.Text type="danger" style={{ fontSize: 12 }}>
                            待重试
                          </Typography.Text>
                        ) : null}
                      </Space>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </Space>
    </div>
  );
}
