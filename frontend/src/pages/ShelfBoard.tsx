/**
 * /shelves 库房排架台
 * 库房排架账与编目台对接：
 * - 按拓本实测尺寸装箱（装具尺寸合计有上限，放不下另起一个；每层装具数定死）
 * - 排架账对账：库房实测尺寸为准，认不出的收藏号挂待认领
 * - 装具写库失败只重试这一个装具，编目台不动
 * - 旧拓本升级时粗分不上的，在「留待上架」里补测重分
 * 消费 Shelf（ShelfLayer / Container / ShelfEntry）+ Rubbing；复用 <StatBadge>、<EmptyPanel>。
 */
import { useMemo, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Col,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudUploadOutlined,
  DeleteOutlined,
  InboxOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import StatBadge from '@/components/common/StatBadge';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectRubbings } from '@/stores/rubbingSlice';
import {
  claimEntry,
  packPending,
  reconcileLedger,
  removeShelfEntry,
  remeasureEntry,
  retryContainer,
  saveShelfConfig,
  selectShelfContainers,
  selectShelfCounters,
  selectShelfEntries,
  selectShelfLayout,
  type ReconcileRow,
} from '@/stores/shelfSlice';
import {
  CONTAINER_STATUS_COLOR,
  CONTAINER_STATUS_LABEL,
  DEFAULT_SHELF_CONFIG,
  SHELF_BUCKET_COLOR,
  SHELF_BUCKET_LABEL,
  SHELF_ENTRY_STATUS_COLOR,
  SHELF_ENTRY_STATUS_LABEL,
  SHELF_FAULT_LABEL,
  type Container,
  type ShelfEntry,
  type ShelfFaultMode,
  type ShelfSizeBucket,
} from '@/types/shelf';
import { getShelfFaultMode, setShelfFaultMode } from '@/utils/shelfGateway';
import { parseSizeCm } from '@/utils/shelfPack';

const FAULT_OPTIONS: ReadonlyArray<{ value: ShelfFaultMode; label: string }> = [
  { value: 'none', label: SHELF_FAULT_LABEL.none },
  { value: 'failNext', label: SHELF_FAULT_LABEL.failNext },
  { value: 'failAlways', label: SHELF_FAULT_LABEL.failAlways },
];

const BUCKET_OPTIONS: ReadonlyArray<{ value: ShelfSizeBucket; label: string }> = [
  { value: 'large', label: SHELF_BUCKET_LABEL.large },
  { value: 'medium', label: SHELF_BUCKET_LABEL.medium },
  { value: 'small', label: SHELF_BUCKET_LABEL.small },
];

export default function ShelfBoard() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();

  const layers = useAppSelector((state) => state.shelf.layers);
  const containers = useAppSelector(selectShelfContainers);
  const entries = useAppSelector(selectShelfEntries);
  const counters = useAppSelector(selectShelfCounters);
  const layout = useAppSelector(selectShelfLayout);
  const config = useAppSelector((state) => state.shelf.config);
  const rubbings = useAppSelector(selectRubbings);

  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [claimTarget, setClaimTarget] = useState<ShelfEntry | null>(null);
  const [remeasureTarget, setRemeasureTarget] = useState<ShelfEntry | null>(null);
  const [faultMode, setFaultMode] = useState<ShelfFaultMode>(getShelfFaultMode());
  const [ledgerText, setLedgerText] = useState('TB-0301,262×90\nTB-9009,205×85');
  const [claimRubbingId, setClaimRubbingId] = useState<string | undefined>(undefined);
  const [remeasureSize, setRemeasureSize] = useState('');
  const [slotsPerLayer, setSlotsPerLayer] = useState(config.slotsPerLayer);
  const [limitLarge, setLimitLarge] = useState(config.limits.large);
  const [limitMedium, setLimitMedium] = useState(config.limits.medium);
  const [limitSmall, setLimitSmall] = useState(config.limits.small);

  const rubbingTitle = (id: string | null): string => {
    if (!id) return '—';
    const rubbing = rubbings.find((item) => item.id === id);
    return rubbing ? `第 ${rubbing.versionNo} 版（${rubbing.collectionNo || '未编号'}）` : id;
  };

  const unclaimedRubbings = useMemo(() => {
    const claimedIds = new Set(
      entries.filter((entry) => entry.rubbingId).map((entry) => entry.rubbingId as string),
    );
    return rubbings.filter((rubbing) => !claimedIds.has(rubbing.id));
  }, [entries, rubbings]);

  const applyFaultMode = (mode: ShelfFaultMode): void => {
    setShelfFaultMode(mode);
    setFaultMode(mode);
    if (mode !== 'none') message.info(`已注入库房故障：${SHELF_FAULT_LABEL[mode]}`);
  };

  const handlePack = async (): Promise<void> => {
    const result = await dispatch(packPending(undefined)).unwrap();
    if (result.shelved > 0) message.success(`已上架 ${result.shelved} 份，新开 ${result.newLayers} 层`);
    if (result.failed > 0) {
      message.warning(`${result.failed} 个装具写库失败，已挂起；其他装具正常上架，可在架位图上只重试失败装具`);
    }
    if (result.held > 0) message.info(`${result.held} 份尺寸分不上，留待上架`);
    if (result.shelved === 0 && result.failed === 0 && result.held === 0) message.info('没有待装入装具的条目');
  };

  const parseLedger = (text: string): ReconcileRow[] =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [collectionNo = '', measuredSizeCm = ''] = line.split(/[,，\t]/);
        return { collectionNo: collectionNo.trim(), measuredSizeCm: measuredSizeCm.trim() };
      })
      .filter((row) => row.collectionNo.length > 0);

  const handleReconcile = async (): Promise<void> => {
    const rows = parseLedger(ledgerText);
    if (rows.length === 0) {
      message.warning('请按「收藏号,实测尺寸」每行一条粘贴排架账');
      return;
    }
    const result = await dispatch(reconcileLedger(rows)).unwrap();
    message.success(
      `对账完成：认出 ${result.matched} 条${result.claimed > 0 ? `（含认领 ${result.claimed}）` : ''}，尺寸以库房为准覆盖 ${result.sizeOverwritten} 条，认不出 ${result.unknown} 条已挂待认领`,
    );
    setLedgerOpen(false);
  };

  const handleClaim = async (): Promise<void> => {
    if (!claimTarget || !claimRubbingId) {
      message.warning('请选择认领的拓本');
      return;
    }
    await dispatch(claimEntry({ entryId: claimTarget.id, rubbingId: claimRubbingId })).unwrap();
    message.success('已认领到拓本，按库房实测尺寸粗分并入待装具队列');
    setClaimTarget(null);
    setClaimRubbingId(undefined);
  };

  const handleRemeasure = async (): Promise<void> => {
    if (!remeasureTarget) return;
    if (!parseSizeCm(remeasureSize)) {
      message.warning('尺寸格式无法辨认，示例：210×88');
      return;
    }
    await dispatch(
      remeasureEntry({ entryId: remeasureTarget.id, measuredSizeCm: remeasureSize }),
    ).unwrap();
    message.success('已按补测尺寸重新粗分');
    setRemeasureTarget(null);
    setRemeasureSize('');
  };

  const handleRetry = async (container: Container): Promise<void> => {
    const result = await dispatch(retryContainer(container.id)).unwrap();
    if (!result) {
      message.warning('该装具没有待重试的条目');
      return;
    }
    if (result.ok) message.success(`装具 ${container.code} 重试成功，本装具 ${result.entryCount} 份已上架`);
    else message.error(`装具 ${container.code} 仍写库失败：${result.error}`);
  };

  const saveConfig = (): void => {
    const next = {
      slotsPerLayer: Math.max(1, Math.trunc(slotsPerLayer)),
      limits: {
        large: Math.max(1, limitLarge),
        medium: Math.max(1, limitMedium),
        small: Math.max(1, limitSmall),
      },
    };
    void dispatch(saveShelfConfig(next));
    message.success('排架定数已更新：只影响之后新开的装具与层');
  };

  const entryColumns: ColumnsType<ShelfEntry> = [
    { title: '收藏号', dataIndex: 'collectionNo', width: 130, render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
    {
      title: '对应拓本',
      dataIndex: 'rubbingId',
      width: 160,
      render: (value: string | null, record) =>
        value ? (
          rubbingTitle(value)
        ) : (
          <Space size={4}>
            <Tag color="red">认不出</Tag>
            {record.status === 'shelved' ? <Tag>实物在架待认领</Tag> : null}
          </Space>
        ),
    },
    {
      title: '库房实测',
      dataIndex: 'measuredSizeCm',
      width: 110,
      render: (value: string, record) =>
        value ? (
          <Space size={4}>
            <span>{value}</span>
            {record.catalogSizeCmSnapshot && record.catalogSizeCmSnapshot !== value ? (
              <Tooltip title={`编目员量得 ${record.catalogSizeCmSnapshot}，以库房量的为准`}>
                <Tag color="orange">改尺</Tag>
              </Tooltip>
            ) : null}
          </Space>
        ) : (
          '未测'
        ),
    },
    {
      title: '粗分',
      dataIndex: 'bucket',
      width: 90,
      render: (value: ShelfSizeBucket | null) =>
        value ? <Tag color={SHELF_BUCKET_COLOR[value]}>{SHELF_BUCKET_LABEL[value]}</Tag> : <Tag>未分</Tag>,
    },
    { title: '装具号', dataIndex: 'containerId', width: 110, render: (value: string | null) => (value ? containers.find((item) => item.id === value)?.code ?? value : '—') },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: ShelfEntry['status']) => <Tag color={SHELF_ENTRY_STATUS_COLOR[value]}>{SHELF_ENTRY_STATUS_LABEL[value]}</Tag>,
    },
    { title: '备注', dataIndex: 'note', render: (value: string, record) => value || (record.lastError ? <Typography.Text type="danger">{record.lastError}</Typography.Text> : '—') },
    {
      title: '操作',
      key: 'action',
      width: 210,
      render: (_value, record) => (
        <Space size={4} wrap>
          {!record.rubbingId ? (
            <Button
              size="small"
              type="link"
              onClick={() => {
                setClaimTarget(record);
                setClaimRubbingId(unclaimedRubbings[0]?.id);
              }}
            >
              认领
            </Button>
          ) : null}
          {record.status === 'pendingShelf' || (record.status === 'pendingClaim' && !record.measuredSizeCm) ? (
            <Button
              size="small"
              type="link"
              onClick={() => {
                setRemeasureTarget(record);
                setRemeasureSize(record.measuredSizeCm);
              }}
            >
              补测尺寸
            </Button>
          ) : null}
          <Popconfirm
            title="销除该排架账条目"
            description="只销库房排架账，不删编目台拓本。"
            okText="确认"
            cancelText="取消"
            onConfirm={() =>
              void dispatch(removeShelfEntry(record.id)).then(() => message.success('已销账'))
            }
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              销账
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const renderEntryTable = (status: ShelfEntry['status'] | 'all') => {
    const rows = status === 'all' ? entries : entries.filter((entry) => entry.status === status);
    return (
      <Table<ShelfEntry>
        rowKey="id"
        size="small"
        pagination={{ pageSize: 8 }}
        columns={entryColumns}
        dataSource={rows}
        locale={{
          emptyText: (
            <EmptyPanel
              title="没有该状态的排架账条目"
              description="可从上方粘贴库房排架账对账，认不出的收藏号会挂在这里等人认领。"
              size="small"
            />
          ),
        }}
      />
    );
  };

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>库房排架台</h2>
          <p>
            库房按拓本实测尺寸往装具里放：一个装具尺寸合计有上限，放不下另起一个；每层装具数定死。
            尺寸以库房量的为准，编目员填的拓法与损泐字位照旧不动。
          </p>
        </div>
        <Space wrap>
          <Button icon={<CloudUploadOutlined />} onClick={() => setLedgerOpen(true)}>
            导入排架账对账
          </Button>
          <Button type="primary" icon={<InboxOutlined />} onClick={() => void handlePack()}>
            装箱上架
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="已上架" value={counters.shelved} suffix="份" tone="success" />
        <StatBadge label="待装具" value={counters.pending} suffix="份" tone="warning" />
        <StatBadge label="待认领" value={counters.pendingClaim} suffix="份" tone="danger" />
        <StatBadge label="留待上架" value={counters.pendingShelf} suffix="份" />
        <StatBadge label="装具" value={containers.length} suffix="个" tone="info" />
        <StatBadge label="柜位层" value={layers.length} suffix="层" tone="primary" />
      </div>

      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="库房写库故障模拟（验证失败隔离）"
        description={
          <Space wrap>
            <Select
              size="small"
              style={{ width: 220 }}
              value={faultMode}
              options={FAULT_OPTIONS as unknown as { value: ShelfFaultMode; label: string }[]}
              onChange={(value: ShelfFaultMode) => applyFaultMode(value)}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              装具写库失败后只重试这一个装具，其余装具照常上架，编目台数据不回滚。
            </Typography.Text>
          </Space>
        }
      />

      <Row gutter={16}>
        <Col xs={24} xl={15}>
          <Card
            title="柜位与装具"
            className="gb-table-card"
            styles={{ body: { padding: 12 } }}
            extra={
              <Space size={4} wrap>
                {SHELF_BUCKET_ORDER_LIST.map((bucket) => (
                  <Tag key={bucket} color={SHELF_BUCKET_COLOR[bucket]}>
                    {SHELF_BUCKET_LABEL[bucket]}上限 {config.limits[bucket]}cm
                  </Tag>
                ))}
                <Tag>每层 {config.slotsPerLayer} 个装具</Tag>
              </Space>
            }
          >
            {layout.length === 0 ? (
              <EmptyPanel
                title="还没有开过装具"
                description="先导入排架账对账，再点「装箱上架」，系统会按尺寸合计上限与每层定数自动开装具、开层。"
                size="small"
              />
            ) : (
              layout.map(({ layer, containers: layerContainers }) => (
                <Card
                  key={layer.id}
                  size="small"
                  type="inner"
                  title={
                    <Space size={6}>
                      <span>{layer.name}</span>
                      <Tag>
                        {layerContainers.length}/{layer.slotCount} 槽
                      </Tag>
                    </Space>
                  }
                  style={{ marginBottom: 10 }}
                  styles={{ body: { padding: 8 } }}
                >
                  <Row gutter={[8, 8]}>
                    {layerContainers.map(({ container, entries: memberEntries }) => (
                      <Col xs={24} md={12} key={container.id}>
                        <div
                          style={{
                            border: `1px solid ${container.status === 'writeFailed' ? '#b03a2e' : 'rgba(47,58,52,0.18)'}`,
                            borderRadius: 8,
                            padding: '6px 10px',
                            background: container.status === 'writeFailed' ? 'rgba(176,58,46,0.05)' : '#fffdf7',
                          }}
                        >
                          <Space size={6} wrap style={{ justifyContent: 'space-between', width: '100%' }}>
                            <Space size={6}>
                              <Typography.Text strong>{container.code}</Typography.Text>
                              <Tag color={SHELF_BUCKET_COLOR[container.bucket]}>{SHELF_BUCKET_LABEL[container.bucket]}</Tag>
                              <Tag color={CONTAINER_STATUS_COLOR[container.status]}>{CONTAINER_STATUS_LABEL[container.status]}</Tag>
                            </Space>
                            {container.status === 'writeFailed' ? (
                              <Button size="small" danger icon={<ReloadOutlined />} onClick={() => void handleRetry(container)}>
                                重试这一个装具
                              </Button>
                            ) : null}
                          </Space>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {container.slotNo} 号位 · 合计 {container.totalSizeCm}/{container.sizeLimitCm}cm · {memberEntries.length} 份
                          </Typography.Text>
                          {container.status === 'writeFailed' ? (
                            <div>
                              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                                {container.lastError}
                              </Typography.Text>
                            </div>
                          ) : null}
                          <Space size={4} wrap style={{ marginTop: 4 }}>
                            {memberEntries.map((entry) => (
                              <Tooltip key={entry.id} title={entry.measuredSizeCm || '尺寸未测'}>
                                <Tag style={{ marginInlineEnd: 0 }}>{entry.collectionNo}</Tag>
                              </Tooltip>
                            ))}
                          </Space>
                        </div>
                      </Col>
                    ))}
                  </Row>
                </Card>
              ))
            )}
          </Card>
        </Col>

        <Col xs={24} xl={9}>
          <Card title="排架定数" size="small" style={{ marginBottom: 16 }}>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Space wrap>
                <span>每层装具数（定死）</span>
                <InputNumber min={1} max={20} value={slotsPerLayer} onChange={(value) => setSlotsPerLayer(value ?? DEFAULT_SHELF_CONFIG.slotsPerLayer)} />
              </Space>
              {BUCKET_OPTIONS.map((option) => {
                const valueMap: Record<ShelfSizeBucket, number> = {
                  large: limitLarge,
                  medium: limitMedium,
                  small: limitSmall,
                };
                const setterMap: Record<ShelfSizeBucket, (value: number) => void> = {
                  large: setLimitLarge,
                  medium: setLimitMedium,
                  small: setLimitSmall,
                };
                return (
                  <Space key={option.value} wrap>
                    <Tag color={SHELF_BUCKET_COLOR[option.value]}>{option.label}</Tag>
                    <span>装具尺寸合计上限</span>
                    <InputNumber min={1} value={valueMap[option.value]} onChange={(value) => setterMap[option.value](value ?? DEFAULT_SHELF_CONFIG.limits[option.value])} />
                    <span>cm</span>
                  </Space>
                );
              })}
              <Button type="primary" ghost icon={<ThunderboltOutlined />} onClick={saveConfig}>
                保存定数
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                定数只影响之后新开的层与装具；已经在架的装具不重排。
              </Typography.Text>
            </Space>
          </Card>

          <Card title="操作说明" size="small">
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 6 }}>
              1. 库房把排架账按「收藏号,实测尺寸」每行一条粘贴进来对账；认不出的收藏号单独挂待认领。
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 6 }}>
              2. 对账时尺寸以库房实测为准，编目台只改尺寸，拓法与损泐字位不动。
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 6 }}>
              3. 装箱按尺寸合计上限顺装，放不下另起装具；每层摆满自动开下一层。
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
              4. 某装具写库失败只挂起这一个装具，点「重试这一个装具」即可，其他装具与编目台不受影响。
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>

      <Card className="gb-table-card" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
        <Tabs
          style={{ padding: '0 12px' }}
          items={[
            { key: 'pending', label: `待装具（${counters.pending}）`, children: renderEntryTable('pending') },
            { key: 'shelved', label: `已上架（${counters.shelved}）`, children: renderEntryTable('shelved') },
            { key: 'pendingClaim', label: `待认领（${counters.pendingClaim}）`, children: renderEntryTable('pendingClaim') },
            { key: 'pendingShelf', label: `留待上架（${counters.pendingShelf}）`, children: renderEntryTable('pendingShelf') },
            { key: 'writeFailed', label: `写库失败（${counters.writeFailed}）`, children: renderEntryTable('writeFailed') },
            { key: 'all', label: `全部（${entries.length}）`, children: renderEntryTable('all') },
          ]}
        />
      </Card>

      {/* 排架账导入 */}
      <Modal
        open={ledgerOpen}
        title="导入库房排架账（对账）"
        okText="对账并入账"
        cancelText="取消"
        onCancel={() => setLedgerOpen(false)}
        onOk={() => void handleReconcile()}
        width={640}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          每行一条「收藏号,库房实测尺寸」。认得出拓本的，以库房尺寸为准覆盖编目台尺寸（拓法与损泐字位不动）；
          认不出的收藏号先单独挂待认领。
        </Typography.Paragraph>
        <Input.TextArea
          rows={8}
          value={ledgerText}
          onChange={(event) => setLedgerText(event.target.value)}
          placeholder={'TB-0301,262×90\nTB-9009,205×85'}
        />
      </Modal>

      {/* 认领 */}
      <Modal
        open={claimTarget !== null}
        title={`认领排架账条目 · ${claimTarget?.collectionNo ?? ''}`}
        okText="确认认领"
        cancelText="取消"
        onCancel={() => setClaimTarget(null)}
        onOk={() => void handleClaim()}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          库房实测：{claimTarget?.measuredSizeCm || '未测'}。认领后条目挂到所选拓本上，尺寸以库房量的为准。
        </Typography.Paragraph>
        <Select
          showSearch
          style={{ width: '100%' }}
          placeholder="选择对应的拓本"
          value={claimRubbingId}
          optionFilterProp="label"
          options={unclaimedRubbings.map((rubbing) => ({
            value: rubbing.id,
            label: `${rubbing.collectionNo || '未编号'} · 第 ${rubbing.versionNo} 版 · ${rubbing.sizeCm || '尺寸未记'}`,
          }))}
          onChange={(value: string) => setClaimRubbingId(value)}
        />
      </Modal>

      {/* 补测尺寸 */}
      <Modal
        open={remeasureTarget !== null}
        title={`补测尺寸 · ${remeasureTarget?.collectionNo ?? ''}`}
        okText="重新粗分"
        cancelText="取消"
        onCancel={() => setRemeasureTarget(null)}
        onOk={() => void handleRemeasure()}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          尺寸可辨后按高度重新粗分（大件 ≥240 / 中件 ≥180 / 小件），并入待装具队列；仍不可辨则继续留待上架。
        </Typography.Paragraph>
        <Input value={remeasureSize} onChange={(event) => setRemeasureSize(event.target.value)} placeholder="如：210×88" />
      </Modal>
    </div>
  );
}

const SHELF_BUCKET_ORDER_LIST: readonly ShelfSizeBucket[] = ['large', 'medium', 'small'];
