/**
 * 写库失败区：库房写库失败、重试耗尽后挂起的单个装具。
 * 库房这边只重试这一个装具；成功后随挂流水转「已上架」，编目台照旧不动。
 */
import { useMemo, useState } from 'react';
import { Alert, App as AntdApp, Button, Card, Space, Table, Tag, Typography } from 'antd';
import { RedoOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { retryContainer, selectContainers, selectShelfIntakes, selectShelfTiers } from '@/stores/shelfSlice';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectRubbings } from '@/stores/rubbingSlice';
import {
  CONTAINER_SIZE_LIMIT_CM,
  CONTAINER_STATUS_LABEL,
  CONTAINER_WRITE_MAX_ATTEMPTS,
  type Container,
} from '@/types/container';
import EmptyPanel from '@/components/common/EmptyPanel';

export default function WriteFailedPanel() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const containers = useAppSelector(selectContainers);
  const tiers = useAppSelector(selectShelfTiers);
  const intakes = useAppSelector(selectShelfIntakes);
  const rubbings = useAppSelector(selectRubbings);
  const [busyId, setBusyId] = useState<string | null>(null);

  const failed = useMemo(() => containers.filter((container) => container.status === 'writeFailed'), [containers]);

  const handleRetry = async (containerId: string): Promise<void> => {
    setBusyId(containerId);
    try {
      const result = await dispatch(retryContainer({ containerId })).unwrap();
      if (result.ok) {
        message.success(`该装具第 ${result.attempts} 次写入成功，随挂 ${result.shelvedIntakeIds.length} 条已转已上架`);
      } else {
        message.error(`仍写库失败：${result.error}`);
      }
    } finally {
      setBusyId(null);
    }
  };

  const itemColumns: ColumnsType<Container['items'][number]> = [
    {
      title: '收藏号',
      width: 130,
      render: (_, item) => {
        const rubbing = rubbings.find((row) => row.id === item.rubbingId);
        return <Tag color="gold">{rubbing?.collectionNo ?? '待认领'}</Tag>;
      },
    },
    { title: '库房实测尺寸', dataIndex: 'sizeCm', width: 130 },
    { title: '计入长边(cm)', dataIndex: 'lengthCm', width: 130 },
  ];

  if (failed.length === 0) {
    return (
      <EmptyPanel
        title="没有写库失败的装具"
        description={`库房写单个装具失败时只重试该装具（最多 ${CONTAINER_WRITE_MAX_ATTEMPTS} 次）；重试仍败才会挂到这里。`}
        size="small"
      />
    );
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type="error"
        showIcon
        message={`${failed.length} 个装具写库失败挂起`}
        description="装具号与柜层槽位已保留；编目台拓本尺寸等数据未回滚、不受影响。请库房排查后逐个重试。"
      />
      {failed.map((container) => {
        const tier = tiers.find((item) => item.id === container.shelfTierId);
        const stuck = intakes.filter((intake) => intake.containerId === container.id);
        return (
          <Card
            key={container.id}
            size="small"
            type="inner"
            title={
              <Space wrap>
                <Tag color="error">{CONTAINER_STATUS_LABEL.writeFailed}</Tag>
                <strong>{container.code}</strong>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  柜位 {tier ? `${tier.code} 槽位 ${container.slotNo ?? '?'}` : '柜层待建'} · 尺寸合计 {container.usedSizeCm}/
                  {CONTAINER_SIZE_LIMIT_CM}cm · 已尝试 {container.attempts} 次
                </Typography.Text>
              </Space>
            }
            extra={
              <Button
                size="small"
                danger
                type="primary"
                icon={<RedoOutlined />}
                loading={busyId === container.id}
                onClick={() => void handleRetry(container.id)}
              >
                重试这一个装具
              </Button>
            }
          >
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Alert type="error" showIcon message={container.lastWriteError || '未知写库错误'} />
              <Table rowKey="rubbingId" size="small" pagination={false} columns={itemColumns} dataSource={container.items} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                随挂流水 {stuck.length} 条：
                {stuck.map((intake) => intake.collectionNo).join('、') || '—'}
              </Typography.Text>
            </Space>
          </Card>
        );
      })}
    </Space>
  );
}
