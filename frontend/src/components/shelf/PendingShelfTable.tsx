/**
 * 待上架流水表：升级粗分分不上 / 库房尺寸无法辨认 / 单件超装具上限。
 * 补量后由库房补测尺寸再装箱（仍以库房实测为准回写编目台）。
 */
import { useMemo, useState } from 'react';
import { App as AntdApp, Button, Input, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { reshelveIntake, selectShelfIntakes } from '@/stores/shelfSlice';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectRubbings } from '@/stores/rubbingSlice';
import { selectSteles } from '@/stores/steleSlice';
import { SHELF_INTAKE_SOURCE_LABEL } from '@/types/shelfIntake';
import EmptyPanel from '@/components/common/EmptyPanel';

export default function PendingShelfTable() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const intakes = useAppSelector(selectShelfIntakes);
  const rubbings = useAppSelector(selectRubbings);
  const steles = useAppSelector(selectSteles);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const rows = useMemo(() => intakes.filter((row) => row.status === 'pendingShelf'), [intakes]);

  const describeRubbing = (rubbingId: string | null): string => {
    if (!rubbingId) return '尚未认领';
    const rubbing = rubbings.find((item) => item.id === rubbingId);
    if (!rubbing) return '拓本已删除';
    const stele = steles.find((item) => item.id === rubbing.steleId);
    return `${stele?.title ?? '未知碑刻'} 第 ${rubbing.versionNo} 版`;
  };

  const handleReshelve = async (intakeId: string): Promise<void> => {
    const measured = drafts[intakeId]?.trim() || null;
    setBusyId(intakeId);
    try {
      const result = await dispatch(reshelveIntake({ intakeId, measuredSize: measured })).unwrap();
      if (result.ok) {
        message.success('已按补测尺寸装箱上架');
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[intakeId];
          return next;
        });
      } else message.error(result.error);
    } finally {
      setBusyId(null);
    }
  };

  const columns: ColumnsType<(typeof rows)[number]> = [
    { title: '收藏号', dataIndex: 'collectionNo', width: 120, render: (value: string) => <Tag color="blue">{value || '无号'}</Tag> },
    { title: '对应拓本', width: 180, render: (_, row) => describeRubbing(row.rubbingId) },
    { title: '原实测 / 编目尺寸', width: 160, render: (_, row) => `${row.measuredSize || '—'}（编目：${row.catalogSizeAtIntake || '未记'}）` },
    {
      title: '来源',
      dataIndex: 'source',
      width: 110,
      render: (value: (typeof rows)[number]['source']) => SHELF_INTAKE_SOURCE_LABEL[value],
    },
    { title: '留待原因', dataIndex: 'note', render: (value: string) => value || '—' },
    {
      title: '库房补测尺寸',
      width: 200,
      render: (_, row) => (
        <Space>
          <Input
            size="small"
            placeholder="如 207×86"
            value={drafts[row.id] ?? row.measuredSize}
            onChange={(event) => setDrafts((prev) => ({ ...prev, [row.id]: event.target.value }))}
          />
          <Button size="small" type="primary" loading={busyId === row.id} onClick={() => void handleReshelve(row.id)}>
            补量上架
          </Button>
        </Space>
      ),
    },
  ];

  if (rows.length === 0) {
    return <EmptyPanel title="没有待上架记录" description="尺寸分不上装具的旧拓本、待补量的入库会留在这里。" size="small" />;
  }

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        共 {rows.length} 条分不上 / 待补量，未占用装具与柜位槽位。
      </Typography.Text>
      <Table rowKey="id" size="small" columns={columns} dataSource={rows} pagination={{ pageSize: 5 }} />
    </Space>
  );
}
