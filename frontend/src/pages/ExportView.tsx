/**
 * /export 编目卡生成与 JSON 结构版本导入导出
 * 按碑刻生成编目卡并支持全库导出、覆盖导入与清空重播种。
 * 消费全部模型；复用 <StatBadge>、<EmptyPanel>、<LossTag>。
 */
import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudDownloadOutlined,
  CloudUploadOutlined,
  FileTextOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import LossTag from '@/components/common/LossTag';
import StatBadge from '@/components/common/StatBadge';
import { useIdbTable } from '@/hooks/useIdbTable';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { loadAll } from '@/stores/store';
import { selectSteles, setCurrentStele } from '@/stores/steleSlice';
import { selectRubbings } from '@/stores/rubbingSlice';
import { selectCompares, selectLosses } from '@/stores/lossSlice';
import { SEAL_TYPE_COLOR, SEAL_TYPE_LABEL, sealPositionWeight, type Seal, type SealType } from '@/types/seal';
import { RUBBING_METHOD_LABEL, RUBBING_STATE_LABEL } from '@/types/rubbing';
import { COMPARE_CONCLUSION_COLOR, COMPARE_CONCLUSION_LABEL } from '@/types/compare';
import {
  DB_NAME,
  DB_SCHEMA_VERSION,
  exportSnapshot,
  importSnapshot,
  readLastBackupAt,
  resetDatabase,
  validateSnapshot,
  writeLastBackupAt,
  type RubbingSnapshot,
} from '@/utils/db';
import {
  buildAllCatalogCards,
  buildCatalogCard,
  copyText,
  exportCatalogCard,
  exportLossLedgerCsv,
  exportSnapshotJson,
} from '@/utils/export';

export default function ExportView() {
  const { message, modal } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const fileRef = useRef<HTMLInputElement>(null);

  const steles = useAppSelector(selectSteles);
  const rubbings = useAppSelector(selectRubbings);
  const losses = useAppSelector(selectLosses);
  const compares = useAppSelector(selectCompares);
  const sealTable = useIdbTable<Seal>((database) => database.seals, { sortByUpdatedAt: false });

  const [steleId, setSteleId] = useState<string>('');
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(readLastBackupAt());

  const activeSteleId = steleId || steles[0]?.id || '';
  const stele = steles.find((item) => item.id === activeSteleId);

  const context = useMemo(
    () => ({
      steles,
      rubbings,
      losses,
      seals: sealTable.rows,
      compares,
    }),
    [compares, losses, rubbings, sealTable.rows, steles],
  );

  const allCardsLength = useMemo(() => buildAllCatalogCards(context).length, [context]);

  const cardText = useMemo(
    () =>
      stele
        ? buildCatalogCard(
            stele,
            rubbings.filter((rubbing) => rubbing.steleId === stele.id),
            losses,
            sealTable.rows,
            compares,
          )
        : '请选择碑刻。',
    [compares, losses, rubbings, sealTable.rows, stele],
  );

  const stat = useMemo(
    () => ({
      steles: steles.length,
      rubbings: rubbings.length,
      losses: losses.length,
      seals: sealTable.rows.length,
      compares: compares.length,
      passPercent:
        compares.length === 0
          ? 0
          : Math.round((compares.filter((compare) => compare.conclusion !== 'pending').length / compares.length) * 100),
    }),
    [compares, losses.length, rubbings.length, sealTable.rows.length, steles.length],
  );

  const handleExport = async (): Promise<void> => {
    const snapshot = await exportSnapshot();
    const filename = exportSnapshotJson(snapshot);
    const stamp = new Date().toISOString();
    writeLastBackupAt(stamp);
    setLastBackupAt(stamp);
    message.success(`已导出 ${filename}（结构版本 v${snapshot.schemaVersion}）`);
  };

  const handleImportClick = (): void => {
    fileRef.current?.click();
  };

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      message.error('JSON 解析失败，请确认文件格式');
      return;
    }
    const invalid = validateSnapshot(parsed);
    if (invalid) {
      message.error(invalid);
      return;
    }
    modal.confirm({
      title: '覆盖导入本地数据',
      content: '导入会清空当前浏览器中的全部碑帖档案，再写入备份内容，操作不可撤销。',
      okText: '确认导入',
      cancelText: '取消',
      onOk: async () => {
        await importSnapshot(parsed as RubbingSnapshot);
        await dispatch(loadAll());
        message.success('导入完成，数据已覆盖');
      },
    });
  };

  const handleReset = async (): Promise<void> => {
    await resetDatabase();
    await dispatch(loadAll());
    message.success('已清空并重新载入演示数据');
  };

  const sealColumns: ColumnsType<Seal> = [
    { title: '位置', dataIndex: 'position', width: 90 },
    { title: '印文', dataIndex: 'sealText', width: 140 },
    {
      title: '印别',
      dataIndex: 'sealType',
      width: 100,
      render: (value: SealType) => <Tag color={SEAL_TYPE_COLOR[value]}>{SEAL_TYPE_LABEL[value]}</Tag>,
    },
    {
      title: '所属拓本',
      dataIndex: 'rubbingId',
      width: 120,
      render: (value: string) => {
        const rubbing = rubbings.find((item) => item.id === value);
        return rubbing ? `第 ${rubbing.versionNo} 版` : '已删除';
      },
    },
    { title: '释文', dataIndex: 'transcription', render: (value: string) => value || '—' },
  ];

  const sealRows = useMemo(
    () =>
      sealTable.rows
        .filter((seal) =>
          rubbings.some((rubbing) => rubbing.id === seal.rubbingId && rubbing.steleId === activeSteleId),
        )
        .sort((a, b) => sealPositionWeight(a.position) - sealPositionWeight(b.position)),
    [activeSteleId, rubbings, sealTable.rows],
  );

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>编目卡生成与数据导出</h2>
          <p>
            本地库 {DB_NAME} · 结构版本 v{DB_SCHEMA_VERSION}
            {lastBackupAt ? ` · 最近导出 ${new Date(lastBackupAt).toLocaleString('zh-CN')}` : ' · 尚未导出过备份'}
          </p>
        </div>
        <Space wrap>
          <Button icon={<CloudDownloadOutlined />} onClick={() => void handleExport()}>
            导出 JSON
          </Button>
          <Button icon={<CloudUploadOutlined />} onClick={handleImportClick}>
            导入 JSON
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(event) => void handleImportFile(event)}
          />
          <Popconfirm
            title="清空并重播种"
            description="会删除当前浏览器中的全部档案并恢复演示数据，不可撤销。"
            okText="确认重置"
            cancelText="取消"
            onConfirm={() => void handleReset()}
          >
            <Button danger icon={<ReloadOutlined />}>
              清空重播种
            </Button>
          </Popconfirm>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="碑刻" value={stat.steles} suffix="处" tone="primary" />
        <StatBadge label="拓本" value={stat.rubbings} suffix="份" tone="info" />
        <StatBadge label="损泐字位" value={stat.losses} suffix="条" tone="warning" />
        <StatBadge label="钤印" value={stat.seals} suffix="方" />
        <StatBadge label="比对记录" value={stat.compares} suffix="条" tone="danger" />
        <StatBadge label="已定断代占比" value={`${stat.passPercent}%`} percent={stat.passPercent} tone="success" />
      </div>

      <Row gutter={16}>
        <Col xs={24} xl={14}>
          <Card
            title="编目卡"
            extra={
              <Space size={4} wrap>
                <Select
                  size="small"
                  style={{ minWidth: 160 }}
                  value={activeSteleId || undefined}
                  placeholder="选择碑刻"
                  options={steles.map((item) => ({ value: item.id, label: item.title }))}
                  onChange={(value: string) => {
                    setSteleId(value);
                    dispatch(setCurrentStele(value));
                  }}
                />
                <Button
                  size="small"
                  icon={<FileTextOutlined />}
                  onClick={() => {
                    if (!stele) return;
                    const filename = exportCatalogCard(
                      stele,
                      rubbings.filter((rubbing) => rubbing.steleId === stele.id),
                      losses,
                      sealTable.rows,
                      compares,
                    );
                    message.success(`已导出 ${filename}`);
                  }}
                >
                  导出本卡
                </Button>
                <Button
                  size="small"
                  onClick={() =>
                    void copyText(cardText).then((ok) =>
                      ok ? message.success('编目卡已复制到剪贴板') : message.warning('浏览器未授权剪贴板'),
                    )
                  }
                >
                  复制
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    const filename = exportCatalogCard(
                      steles[0] ?? {
                        id: '',
                        title: '全部碑刻',
                        era: '',
                        location: '',
                        form: 'stele',
                        sizeCm: '',
                        calligrapher: '',
                        createdAt: 0,
                        updatedAt: 0,
                      },
                      rubbings,
                      losses,
                      sealTable.rows,
                      compares,
                    );
                    message.success(`已导出 ${filename}（含全部碑刻）`);
                  }}
                >
                  导出合订
                </Button>
              </Space>
            }
          >
            {steles.length === 0 ? (
              <EmptyPanel
                title="还没有碑刻档案"
                description="先在碑刻台账中登记碑刻与拓本，再生成编目卡。"
                size="small"
              />
            ) : (
              <>
                <pre style={{ maxHeight: 380, overflow: 'auto', fontSize: 12, margin: 0, whiteSpace: 'pre-wrap' }}>
                  {cardText}
                </pre>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  合订文本共 {allCardsLength} 字符，含全部 {steles.length} 处碑刻。
                </Typography.Text>
              </>
            )}
          </Card>
        </Col>

        <Col xs={24} xl={10}>
          <Card
            className="gb-table-card"
            title={`钤印明细${stele ? ` · ${stele.title}` : ''}`}
            styles={{ body: { padding: 0 } }}
          >
            {sealRows.length === 0 ? (
              <EmptyPanel
                title="该碑刻下暂无钤印记录"
                description="可在拓本登记页的「钤印」对话框中登记收藏印、鉴赏印与作者印。"
                size="small"
              />
            ) : (
              <Table<Seal> rowKey="id" size="small" pagination={{ pageSize: 5 }} columns={sealColumns} dataSource={sealRows} />
            )}
          </Card>

          <Card title="整库导出" style={{ marginTop: 16 }}>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Typography.Text type="secondary">
                导出文件包含 5 张业务表全量数据与结构版本号，可在其他设备通过「导入 JSON」还原。
              </Typography.Text>
              <Space wrap>
                <Button icon={<CloudDownloadOutlined />} onClick={() => void handleExport()}>
                  JSON 备份
                </Button>
                <Button
                  onClick={() => {
                    const filename = exportLossLedgerCsv(context);
                    message.success(`已导出 ${filename}`);
                  }}
                >
                  损泐台账 CSV
                </Button>
              </Space>
              <Alert
                type="info"
                showIcon
                message="无状态容器"
                description="服务端不保存任何数据；清理浏览器站点数据会丢失档案，请定期导出备份。"
              />
            </Space>
          </Card>

          <Card title="拓本状态一览" style={{ marginTop: 16 }} size="small">
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              {rubbings.filter((rubbing) => rubbing.steleId === activeSteleId).length === 0 ? (
                <Typography.Text type="secondary">该碑刻下暂无拓本</Typography.Text>
              ) : (
                rubbings
                  .filter((rubbing) => rubbing.steleId === activeSteleId)
                  .map((rubbing) => (
                    <Space key={rubbing.id} size={6} wrap>
                      <Tag color="#2f3a34">第 {rubbing.versionNo} 版</Tag>
                      <Tag>{RUBBING_METHOD_LABEL[rubbing.method]}</Tag>
                      <Tag color="gold">{RUBBING_STATE_LABEL[rubbing.state]}</Tag>
                      <Space size={4} wrap>
                        {losses
                          .filter((loss) => loss.rubbingId === rubbing.id)
                          .slice(0, 2)
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
                    </Space>
                  ))
              )}
              {compares
                .filter((compare) => compare.steleId === activeSteleId)
                .map((compare) => (
                  <Tag key={compare.id} color={COMPARE_CONCLUSION_COLOR[compare.conclusion]}>
                    {compare.date} 比对结论：{COMPARE_CONCLUSION_LABEL[compare.conclusion]}（差异 {compare.diffCount} 字）
                  </Tag>
                ))}
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
