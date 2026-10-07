/**
 * 待认领流水表：排架账上认不出对应拓本的收藏号，单独记着等人认领。
 * 认领时同样按库房实测尺寸装箱；尺寸与编目台不符以库房实测为准。
 */
import { useMemo, useState } from 'react';
import { App as AntdApp, Button, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { claimIntake, deleteIntake } from '@/stores/shelfSlice';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectShelfIntakes } from '@/stores/shelfSlice';
import { selectRubbings } from '@/stores/rubbingSlice';
import { selectSteles } from '@/stores/steleSlice';
import { SHELF_INTAKE_SOURCE_LABEL } from '@/types/shelfIntake';
import EmptyPanel from '@/components/common/EmptyPanel';

export default function PendingClaimTable() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const intakes = useAppSelector(selectShelfIntakes);
  const rubbings = useAppSelector(selectRubbings);
  const steles = useAppSelector(selectSteles);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, string | undefined>>({});

  const rows = useMemo(() => intakes.filter((row) => row.status === 'pendingClaim'), [intakes]);

  const steleTitle = (steleId: string): string => steles.find((stele) => stele.id === steleId)?.title ?? '未知碑刻';

  const claimOptions = useMemo(
    () =>
      rubbings.map((rubbing) => ({
        value: rubbing.id,
        label: `${rubbing.collectionNo || '无号'} · ${steleTitle(rubbing.steleId)} 第 ${rubbing.versionNo} 版（${rubbing.sizeCm || '尺寸未记'}）`,
      })),
    // steleTitle 随 steles 变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rubbings, steles],
  );

  const handleClaim = async (intakeId: string): Promise<void> => {
    const rubbingId = picked[intakeId];
    if (!rubbingId) {
      message.warning('请先选择要认领的拓本');
      return;
    }
    setBusyId(intakeId);
    try {
      const result = await dispatch(claimIntake({ intakeId, rubbingId })).unwrap();
      if (result.ok) message.success('已认领并按库房实测尺寸装箱');
      else message.error(result.error);
    } finally {
      setBusyId(null);
    }
  };

  const columns: ColumnsType<(typeof rows)[number]> = [
    { title: '收藏号', dataIndex: 'collectionNo', width: 120, render: (value: string) => <Tag color="gold">{value}</Tag> },
    { title: '库房实测', dataIndex: 'measuredSize', width: 120 },
    {
      title: '来源',
      dataIndex: 'source',
      width: 110,
      render: (value: (typeof rows)[number]['source']) => SHELF_INTAKE_SOURCE_LABEL[value],
    },
    { title: '备注', dataIndex: 'note', render: (value: string) => value || '—' },
    {
      title: '认领拓本',
      width: 300,
      render: (_, row) => (
        <Select
          showSearch
          size="small"
          style={{ width: '100%' }}
          placeholder="选择编目台拓本"
          optionFilterProp="label"
          value={picked[row.id]}
          onChange={(value: string) => setPicked((prev) => ({ ...prev, [row.id]: value }))}
          options={claimOptions}
        />
      ),
    },
    {
      title: '操作',
      width: 170,
      render: (_, row) => (
        <Space size={4}>
          <Button size="small" type="primary" loading={busyId === row.id} onClick={() => void handleClaim(row.id)}>
            认领并装箱
          </Button>
          <Popconfirm
            title="删除这条排架账？"
            description="仅删除流水，编目台拓本不动。"
            okText="删除"
            cancelText="取消"
            onConfirm={() => {
              void dispatch(deleteIntake(row.id));
              message.success('已删除该流水');
            }}
          >
            <Button size="small" danger>
              删行
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  if (rows.length === 0) {
    return (
      <EmptyPanel
        title="没有待认领的收藏号"
        description="排架账上认不出对应拓本的收藏号会单独留在这里，等人认领。"
        size="small"
      />
    );
  }

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Typography.Text type="warning" style={{ fontSize: 12 }}>
        共 {rows.length} 条收藏号在编目台查无对应拓本，已单独记账，未计入任何装具。
      </Typography.Text>
      <Table rowKey="id" size="small" columns={columns} dataSource={rows} pagination={{ pageSize: 5 }} />
    </Space>
  );
}
