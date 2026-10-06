/**
 * /rubbings 拓本登记
 * 录入拓法、纸墨、尺寸与收藏号并管理钤印；同一碑刻下自动生成版本序号，支持批量改状态。
 * 消费 Rubbing、Seal、Stele；复用 <FilterBar>、<StatBadge>、<EmptyPanel>、<LossTag>。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EditOutlined, PlusOutlined, TagsOutlined } from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectSteles, setCurrentStele } from '@/stores/steleSlice';
import {
  advanceRubbingState,
  batchUpdateRubbings,
  batchUpdateSeals,
  createRubbing,
  createSeal,
  loadRubbings,
  removeRubbing,
  removeSeal,
  resetRubbingFilters,
  selectFilteredRubbings,
  selectRubbings,
  selectSeals,
  setRubbingMethods,
  setRubbingKeyword,
  setRubbingStates,
  setRubbingSteleFilter,
  updateRubbing,
  updateSeal,
} from '@/stores/rubbingSlice';
import {
  INK_TONE_LABEL,
  INK_TONE_OPTIONS,
  PAPER_TYPE_OPTIONS,
  RUBBING_METHOD_LABEL,
  RUBBING_METHOD_OPTIONS,
  RUBBING_STATE_COLOR,
  RUBBING_STATE_LABEL,
  RUBBING_STATE_OPTIONS,
  createEmptyRubbingDraft,
  type InkTone,
  type Rubbing,
  type RubbingDraft,
  type RubbingMethod,
  type RubbingState,
} from '@/types/rubbing';
import {
  SEAL_POSITION_OPTIONS,
  SEAL_TYPE_COLOR,
  SEAL_TYPE_LABEL,
  SEAL_TYPE_OPTIONS,
  createEmptySealDraft,
  sealPositionWeight,
  type Seal,
  type SealDraft,
  type SealType,
} from '@/types/seal';
import { selectLosses } from '@/stores/lossSlice';
import LossTag from '@/components/common/LossTag';

const FILTER_KEYS = ['method', 'state'] as const;

export default function RubbingList() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const [form] = Form.useForm<RubbingDraft>();
  const [sealForm] = Form.useForm<SealDraft>();

  const steles = useAppSelector(selectSteles);
  const rubbings = useAppSelector(selectRubbings);
  const filtered = useAppSelector(selectFilteredRubbings);
  const seals = useAppSelector(selectSeals);
  const losses = useAppSelector(selectLosses);
  const steleFilterId = useAppSelector((state) => state.rubbing.filters.steleId);

  const url = useFilterQuery(FILTER_KEYS);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Rubbing | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchState, setBatchState] = useState<RubbingState>('cataloged');

  const [sealOpen, setSealOpen] = useState(false);
  const [sealRubbing, setSealRubbing] = useState<Rubbing | null>(null);
  const [editingSeal, setEditingSeal] = useState<Seal | null>(null);
  const [selectedSealIds, setSelectedSealIds] = useState<string[]>([]);
  const [batchSealType, setBatchSealType] = useState<SealType>('collection');

  useEffect(() => {
    dispatch(setRubbingKeyword(url.keyword));
    dispatch(setRubbingMethods((url.values.method ?? []) as RubbingMethod[]));
    dispatch(setRubbingStates((url.values.state ?? []) as RubbingState[]));
  }, [dispatch, url.keyword, url.values]);

  const selects: FilterSelectConfig[] = useMemo(
    () => [
      { key: 'method', label: '拓法', options: RUBBING_METHOD_OPTIONS.map((item) => ({ value: item.value, label: item.label })) },
      { key: 'state', label: '状态', options: RUBBING_STATE_OPTIONS.map((item) => ({ value: item.value, label: item.label })) },
    ],
    [],
  );

  const stat = useMemo(() => {
    const total = rubbings.length;
    const cataloged = rubbings.filter((rubbing) => rubbing.state === 'cataloged').length;
    return {
      total,
      cataloged,
      catalogedPercent: total === 0 ? 0 : Math.round((cataloged / total) * 100),
      toCompare: rubbings.filter((rubbing) => rubbing.state === 'toCompare').length,
      seals: seals.length,
      losses: losses.length,
    };
  }, [losses.length, rubbings, seals.length]);

  const steleTitle = (steleId: string): string => steles.find((stele) => stele.id === steleId)?.title ?? steleId;

  const nextVersionNo = (steleId: string): number => {
    const list = rubbings.filter((rubbing) => rubbing.steleId === steleId);
    return list.length === 0 ? 1 : Math.max(...list.map((rubbing) => rubbing.versionNo)) + 1;
  };

  const openCreate = (): void => {
    const steleId = steleFilterId ?? steles[0]?.id ?? '';
    if (!steleId) {
      message.warning('请先在碑刻台账中登记碑刻');
      return;
    }
    setEditing(null);
    form.setFieldsValue(createEmptyRubbingDraft(steleId, nextVersionNo(steleId)));
    setOpen(true);
  };

  const openEdit = (rubbing: Rubbing): void => {
    setEditing(rubbing);
    form.setFieldsValue({
      steleId: rubbing.steleId,
      versionNo: rubbing.versionNo,
      method: rubbing.method,
      paperType: rubbing.paperType,
      inkTone: rubbing.inkTone,
      sizeCm: rubbing.sizeCm,
      collectionNo: rubbing.collectionNo,
      dateGuess: rubbing.dateGuess,
      state: rubbing.state,
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    if (editing) {
      await dispatch(updateRubbing({ id: editing.id, patch: values })).unwrap();
      message.success(`已更新第 ${values.versionNo} 版拓本`);
    } else {
      await dispatch(createRubbing(values)).unwrap();
      message.success(`已登记第 ${values.versionNo} 版拓本`);
    }
    setOpen(false);
  };

  const openSeals = (rubbing: Rubbing): void => {
    setSealRubbing(rubbing);
    setEditingSeal(null);
    setSelectedSealIds([]);
    sealForm.setFieldsValue(createEmptySealDraft(rubbing.id));
    setSealOpen(true);
  };

  const submitSeal = async (): Promise<void> => {
    if (!sealRubbing) return;
    const values = await sealForm.validateFields();
    if (editingSeal) {
      await dispatch(updateSeal({ id: editingSeal.id, patch: values })).unwrap();
      message.success('已更新钤印');
    } else {
      await dispatch(createSeal({ ...values, rubbingId: sealRubbing.id })).unwrap();
      message.success('已登记钤印');
    }
    setEditingSeal(null);
    sealForm.setFieldsValue(createEmptySealDraft(sealRubbing.id));
  };

  const columns: ColumnsType<Rubbing> = [
    {
      title: '版本',
      dataIndex: 'versionNo',
      width: 90,
      sorter: (a, b) => a.versionNo - b.versionNo,
      render: (value: number, record) => (
        <Space size={4}>
          <Tag color="#2f3a34">第 {value} 版</Tag>
          <Tag color={RUBBING_STATE_COLOR[record.state]}>{RUBBING_STATE_LABEL[record.state]}</Tag>
        </Space>
      ),
    },
    { title: '碑刻', dataIndex: 'steleId', width: 130, render: (value: string) => steleTitle(value) },
    { title: '拓法', dataIndex: 'method', width: 100, render: (value: RubbingMethod) => RUBBING_METHOD_LABEL[value] },
    { title: '纸种', dataIndex: 'paperType', width: 100 },
    { title: '墨色', dataIndex: 'inkTone', width: 90, render: (value: InkTone) => INK_TONE_LABEL[value] },
    { title: '尺寸', dataIndex: 'sizeCm', width: 110, render: (value: string) => value || '未记' },
    { title: '收藏号', dataIndex: 'collectionNo', width: 120, render: (value: string) => value || '未编' },
    { title: '年代判断', dataIndex: 'dateGuess', width: 120, render: (value: string) => value || '待考' },
    {
      title: '损泐 / 钤印',
      key: 'counts',
      width: 130,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text style={{ fontSize: 12 }}>
            损泐 {losses.filter((loss) => loss.rubbingId === record.id).length} 条
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            钤印 {seals.filter((seal) => seal.rubbingId === record.id).length} 方
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 250,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button size="small" type="link" onClick={() => void dispatch(advanceRubbingState(record.id))}>
            推进状态
          </Button>
          <Button size="small" type="link" icon={<TagsOutlined />} onClick={() => openSeals(record)}>
            钤印
          </Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除拓本"
            description="将同时删除其损泐字位与钤印记录。"
            okText="确认"
            cancelText="取消"
            onConfirm={() =>
              void dispatch(removeRubbing(record.id))
                .unwrap()
                .then(() => dispatch(loadRubbings()))
                .then(() => message.success('已删除拓本'))
            }
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const sealRows = sealRubbing
    ? seals
        .filter((seal) => seal.rubbingId === sealRubbing.id)
        .sort((a, b) => sealPositionWeight(a.position) - sealPositionWeight(b.position))
    : [];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>拓本登记</h2>
          <p>录入拓法、纸墨、尺寸与收藏号；同一碑刻下自动生成版本序号，并可管理钤印与批量改状态。</p>
        </div>
        <Space wrap>
          <Select
            allowClear
            style={{ minWidth: 200 }}
            placeholder="全部碑刻"
            value={steleFilterId ?? undefined}
            options={steles.map((stele) => ({ value: stele.id, label: stele.title }))}
            onChange={(value: string | undefined) => {
              dispatch(setRubbingSteleFilter(value ?? null));
              if (value) dispatch(setCurrentStele(value));
            }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            登记拓本
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="拓本总数" value={stat.total} suffix="份" tone="primary" />
        <StatBadge label="已编目占比" value={`${stat.catalogedPercent}%`} percent={stat.catalogedPercent} tone="success" />
        <StatBadge label="待比对" value={stat.toCompare} suffix="份" tone="warning" />
        <StatBadge label="钤印总数" value={stat.seals} suffix="方" tone="info" />
        <StatBadge label="损泐字位" value={stat.losses} suffix="条" tone="danger" />
      </div>

      <FilterBar
        keyword={url.keyword}
        onKeywordChange={url.setKeyword}
        selects={selects}
        values={url.values}
        onValuesChange={url.setValues}
        onReset={() => {
          url.reset();
          dispatch(resetRubbingFilters());
        }}
        keywordPlaceholder="搜索收藏号 / 纸种 / 年代判断…"
        actions={
          <Space size={6} wrap>
            <Select
              size="small"
              style={{ width: 120 }}
              value={batchState}
              options={[...RUBBING_STATE_OPTIONS]}
              onChange={(value: RubbingState) => setBatchState(value)}
            />
            <Button
              size="small"
              disabled={selectedIds.length === 0}
              onClick={() =>
                void dispatch(batchUpdateRubbings({ ids: selectedIds, patch: { state: batchState } }))
                  .unwrap()
                  .then(() => {
                    message.success(`已批量置为${RUBBING_STATE_LABEL[batchState]}`);
                    setSelectedIds([]);
                  })
              }
            >
              批量改状态
            </Button>
          </Space>
        }
      />

      <Card className="gb-table-card" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
        {filtered.length === 0 ? (
          <EmptyPanel
            title={rubbings.length === 0 ? '还没有登记拓本' : '当前筛选条件下没有拓本'}
            description={
              rubbings.length === 0
                ? '为碑刻登记第一份拓本，记录拓法、纸墨与收藏号，版本序号会自动生成。'
                : '试着调整拓法或状态筛选条件。'
            }
            actionText="登记拓本"
            onAction={openCreate}
            secondaryText="重置筛选"
            onSecondary={() => url.reset()}
            size="small"
          />
        ) : (
          <Table<Rubbing>
            rowKey="id"
            size="small"
            pagination={{ pageSize: 8 }}
            columns={columns}
            dataSource={filtered}
            rowSelection={{
              selectedRowKeys: selectedIds,
              onChange: (keys) => setSelectedIds(keys.map((key) => String(key))),
            }}
          />
        )}
      </Card>

      <Modal
        open={open}
        title={editing ? `编辑第 ${editing.versionNo} 版拓本` : '登记拓本'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="steleId" label="所属碑刻" rules={[{ required: true }]} style={{ flex: 2 }}>
              <Select
                options={steles.map((stele) => ({ value: stele.id, label: stele.title }))}
                onChange={(value: string) => form.setFieldsValue({ versionNo: nextVersionNo(value) })}
              />
            </Form.Item>
            <Form.Item name="versionNo" label="版本序号" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="number" min={1} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="method" label="拓法" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...RUBBING_METHOD_OPTIONS]} />
            </Form.Item>
            <Form.Item name="inkTone" label="墨色" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...INK_TONE_OPTIONS]} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="paperType" label="纸种" style={{ flex: 1 }}>
              <Select options={PAPER_TYPE_OPTIONS.map((item) => ({ value: item, label: item }))} />
            </Form.Item>
            <Form.Item name="sizeCm" label="尺寸（厘米）" style={{ flex: 1 }}>
              <Input placeholder="如：210×88" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="collectionNo" label="收藏号" style={{ flex: 1 }}>
              <Input placeholder="如：TB-0101" />
            </Form.Item>
            <Form.Item name="dateGuess" label="年代判断" style={{ flex: 1 }}>
              <Input placeholder="如：明拓" />
            </Form.Item>
          </Space>
          <Form.Item name="state" label="状态" rules={[{ required: true }]}>
            <Select options={[...RUBBING_STATE_OPTIONS]} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 钤印管理 */}
      <Modal
        open={sealOpen}
        title={`钤印管理 · ${sealRubbing ? `第 ${sealRubbing.versionNo} 版（${steleTitle(sealRubbing.steleId)}）` : ''}`}
        onCancel={() => setSealOpen(false)}
        footer={null}
        width={760}
        destroyOnClose
      >
        <Form form={sealForm} layout="inline" style={{ marginBottom: 10, rowGap: 8 }}>
          <Form.Item name="sealText" label="印文" rules={[{ required: true, message: '请填写印文' }]}>
            <Input placeholder="如：端方藏碑" style={{ width: 150 }} />
          </Form.Item>
          <Form.Item name="position" label="位置">
            <Select style={{ width: 110 }} options={SEAL_POSITION_OPTIONS.map((item) => ({ value: item, label: item }))} />
          </Form.Item>
          <Form.Item name="sealType" label="印别">
            <Select style={{ width: 110 }} options={[...SEAL_TYPE_OPTIONS]} />
          </Form.Item>
          <Form.Item name="transcription" label="释文">
            <Input placeholder="释文说明" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" onClick={() => void submitSeal()}>
                {editingSeal ? '保存修改' : '新增钤印'}
              </Button>
              {editingSeal ? (
                <Button
                  onClick={() => {
                    setEditingSeal(null);
                    if (sealRubbing) sealForm.setFieldsValue(createEmptySealDraft(sealRubbing.id));
                  }}
                >
                  取消编辑
                </Button>
              ) : null}
            </Space>
          </Form.Item>
        </Form>

        <Space size={6} style={{ marginBottom: 8 }} wrap>
          <Select
            size="small"
            style={{ width: 120 }}
            value={batchSealType}
            options={[...SEAL_TYPE_OPTIONS]}
            onChange={(value: SealType) => setBatchSealType(value)}
          />
          <Button
            size="small"
            disabled={selectedSealIds.length === 0}
            onClick={() =>
              void dispatch(batchUpdateSeals({ ids: selectedSealIds, sealType: batchSealType }))
                .unwrap()
                .then(() => {
                  message.success(`已批量改为${SEAL_TYPE_LABEL[batchSealType]}`);
                  setSelectedSealIds([]);
                })
            }
          >
            批量改印别
          </Button>
        </Space>

        <Table<Seal>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={sealRows}
          rowSelection={{
            selectedRowKeys: selectedSealIds,
            onChange: (keys) => setSelectedSealIds(keys.map((key) => String(key))),
          }}
          locale={{ emptyText: '该拓本暂无钤印记录' }}
          columns={[
            { title: '位置', dataIndex: 'position', width: 90 },
            { title: '印文', dataIndex: 'sealText', width: 150 },
            {
              title: '印别',
              dataIndex: 'sealType',
              width: 100,
              render: (value: SealType) => <Tag color={SEAL_TYPE_COLOR[value]}>{SEAL_TYPE_LABEL[value]}</Tag>,
            },
            { title: '释文', dataIndex: 'transcription' },
            {
              title: '操作',
              key: 'action',
              width: 130,
              render: (_value, record) => (
                <Space size={4}>
                  <Button
                    size="small"
                    type="link"
                    onClick={() => {
                      setEditingSeal(record);
                      sealForm.setFieldsValue({
                        rubbingId: record.rubbingId,
                        sealText: record.sealText,
                        position: record.position,
                        transcription: record.transcription,
                        sealType: record.sealType,
                      });
                    }}
                  >
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除该钤印"
                    okText="确认"
                    cancelText="取消"
                    onConfirm={() => void dispatch(removeSeal(record.id)).then(() => message.success('已删除'))}
                  >
                    <Button size="small" type="link" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />

        {sealRubbing ? (
          <div style={{ marginTop: 10 }}>
            <Typography.Text type="secondary">
              该拓本损泐字位：
            </Typography.Text>
            <Space size={4} wrap style={{ marginTop: 4 }}>
              {losses
                .filter((loss) => loss.rubbingId === sealRubbing.id)
                .map((loss) => (
                  <LossTag
                    key={loss.id}
                    type={loss.type}
                    severity={loss.severity}
                    lineNo={loss.lineNo}
                    charNo={loss.charNo}
                    size="small"
                  />
                ))}
            </Space>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
