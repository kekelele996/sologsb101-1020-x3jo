/**
 * 入库流水台账：排架账全量行，按状态筛选查看。
 * 行内含库房实测 / 编目原记（尺寸改记留痕）、装具与柜层槽位、尝试次数。
 */
import { useMemo, useState } from 'react';
import { App as AntdApp, Button, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import { ExportOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { selectContainers, selectShelfIntakes, selectShelfTiers } from '@/stores/shelfSlice';
import { useAppSelector } from '@/stores/store';
import { selectRubbings } from '@/stores/rubbingSlice';
import { selectSteles } from '@/stores/steleSlice';
import {
  SHELF_INTAKE_SOURCE_LABEL,
  SHELF_INTAKE_STATUS_COLOR,
  SHELF_INTAKE_STATUS_LABEL,
  type ShelfIntake,
  type ShelfIntakeStatus,
} from '@/types/shelfIntake';
import { exportShelfLedgerCsv } from '@/utils/export';

type StatusFilter = ShelfIntakeStatus | 'all';

export default function IntakeLedger() {
  const { message } = AntdApp.useApp();
  const intakes = useAppSelector(selectShelfIntakes);
  const containers = useAppSelector(selectContainers);
  const tiers = useAppSelector(selectShelfTiers);
  const rubbings = useAppSelector(selectRubbings);
  const steles = useAppSelector(selectSteles);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [batchFilter, setBatchFilter] = useState<string>('all');

  const batches = useMemo(
    () => Array.from(new Set(intakes.map((row) => row.batchNo))).sort((a, b) => (a < b ? 1 : -1)),
    [intakes],
  );

  const rows = useMemo(
    () =>
      intakes.filter(
        (row) =>
          (statusFilter === 'all' || row.status === statusFilter) &&
          (batchFilter === 'all' || row.batchNo === batchFilter),
      ),
    [batchFilter, intakes, statusFilter],
  );

  const rubbingLabel = (row: ShelfIntake): string => {
    if (!row.rubbingId) return '—';
    const rubbing = rubbings.find((item) => item.id === row.rubbingId);
    if (!rubbing) return '拓本已删';
    const stele = steles.find((item) => item.id === rubbing.steleId);
    return `${stele?.title ?? '?'} 第${rubbing.versionNo}版`;
  };

  const placementLabel = (row: ShelfIntake): string => {
    if (!row.containerId) return '—';
    const container = containers.find((item) => item.id === row.containerId);
    if (!container) return '—';
    const tier = container.shelfTierId ? tiers.find((item) => item.id === container.shelfTierId) : undefined;
    return `${container.code}${tier ? `（${tier.code}-${container.slotNo ?? '?'}）` : ''}`;
  };

  const columns: ColumnsType<ShelfIntake> = [
    { title: '批次', dataIndex: 'batchNo', width: 150 },
    { title: '收藏号', dataIndex: 'collectionNo', width: 110, render: (value: string) => value || '—' },
    { title: '对应拓本', width: 150, render: (_, row) => rubbingLabel(row) },
    { title: '库房实测', dataIndex: 'measuredSize', width: 100, render: (value: string) => <strong>{value || '—'}</strong> },
    {
      title: '编目原记',
      dataIndex: 'catalogSizeAtIntake',
      width: 100,
      render: (value: string, row) => (
        <Space size={4}>
          <span>{value || '—'}</span>
          {row.reconciled ? <Tag color="orange">以库房为准</Tag> : null}
        </Space>
      ),
    },
    { title: '装具 / 柜层', width: 170, render: (_, row) => placementLabel(row) },
    {
      title: '状态',
      dataIndex: 'status',
      width: 96,
      render: (value: ShelfIntakeStatus) => <Tag color={SHELF_INTAKE_STATUS_COLOR[value]}>{SHELF_INTAKE_STATUS_LABEL[value]}</Tag>,
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 100,
      render: (value: ShelfIntake['source']) => SHELF_INTAKE_SOURCE_LABEL[value],
    },
    { title: '尝试', dataIndex: 'attempts', width: 60 },
    { title: '备注 / 失败原因', dataIndex: 'note', render: (value: string, row) => value || row.lastWriteError || '—' },
  ];

  const handleExportCsv = (): void => {
    const filename = exportShelfLedgerCsv({ tiers, containers, intakes, rubbings });
    message.success(`已导出 ${filename}`);
  };

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space wrap>
          <Segmented<StatusFilter>
            size="small"
            value={statusFilter}
            onChange={(value) => setStatusFilter(value)}
            options={[
              { value: 'all', label: `全部 ${intakes.length}` },
              { value: 'shelved', label: `已上架 ${intakes.filter((row) => row.status === 'shelved').length}` },
              { value: 'pendingClaim', label: `待认领 ${intakes.filter((row) => row.status === 'pendingClaim').length}` },
              { value: 'pendingShelf', label: `待上架 ${intakes.filter((row) => row.status === 'pendingShelf').length}` },
              { value: 'writeFailed', label: `写库失败 ${intakes.filter((row) => row.status === 'writeFailed').length}` },
              { value: 'duplicate', label: `重复 ${intakes.filter((row) => row.status === 'duplicate').length}` },
            ]}
          />
          <Select
            size="small"
            style={{ minWidth: 180 }}
            value={batchFilter}
            onChange={(value: string) => setBatchFilter(value)}
            options={[{ value: 'all', label: '全部批次' }, ...batches.map((batch) => ({ value: batch, label: batch }))]}
          />
        </Space>
        <Button size="small" icon={<ExportOutlined />} onClick={handleExportCsv}>
          导出排架账 CSV
        </Button>
      </Space>
      {rows.length === 0 ? (
        <Typography.Text type="secondary">当前筛选下没有流水。</Typography.Text>
      ) : (
        <Table rowKey="id" size="small" columns={columns} dataSource={rows} pagination={{ pageSize: 8 }} scroll={{ x: 1200 }} />
      )}
    </Space>
  );
}
