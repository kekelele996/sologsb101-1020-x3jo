/**
 * /compare 同碑多版本比对与断代
 * 选定两个拓本即生成损泐差异清单并排展示，可落库为比对记录并回写断代结论。
 * 消费 Compare、Loss、Rubbing；复用 <LossTag>、<StatBadge>、<EmptyPanel>、<FilterBar>。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, EditOutlined, SaveOutlined, SwapOutlined } from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import LossTag from '@/components/common/LossTag';
import StatBadge from '@/components/common/StatBadge';
import { useLossDiff } from '@/hooks/useLossDiff';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectSteles, setCurrentStele } from '@/stores/steleSlice';
import { selectRubbings } from '@/stores/rubbingSlice';
import {
  loadLosses,
  removeCompare,
  saveCompare,
  selectCompares,
  selectLosses,
  setCompareA,
  setCompareB,
  updateCompare,
} from '@/stores/lossSlice';
import { LOSS_TYPE_OPTIONS, type LossType } from '@/types/loss';
import {
  COMPARE_CONCLUSION_COLOR,
  COMPARE_CONCLUSION_LABEL,
  COMPARE_CONCLUSION_OPTIONS,
  createEmptyCompareDraft,
  type Compare,
  type CompareConclusion,
  type CompareDraft,
} from '@/types/compare';
import { buildDiffText, copyText } from '@/utils/export';
import { encodeCoord } from '@/utils/collate';

const FILTER_KEYS = ['type'] as const;

export default function CompareView() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const [form] = Form.useForm<CompareDraft>();

  const steles = useAppSelector(selectSteles);
  const rubbings = useAppSelector(selectRubbings);
  const compares = useAppSelector(selectCompares);
  const losses = useAppSelector(selectLosses);
  const compareAId = useAppSelector((state) => state.loss.compareAId);
  const compareBId = useAppSelector((state) => state.loss.compareBId);
  const currentSteleId = useAppSelector((state) => state.stele.currentSteleId);

  const url = useFilterQuery(FILTER_KEYS);
  const [steleId, setSteleId] = useState<string>('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Compare | null>(null);

  useEffect(() => {
    if (steleId.length === 0) {
      setSteleId(currentSteleId ?? steles[0]?.id ?? '');
    }
  }, [currentSteleId, steleId, steles]);

  const steleRubbings = useMemo(
    () => rubbings.filter((rubbing) => rubbing.steleId === steleId).sort((a, b) => a.versionNo - b.versionNo),
    [rubbings, steleId],
  );

  // 同碑切换时重置比对双方为前两版
  useEffect(() => {
    const [first, second] = steleRubbings;
    if (!first) {
      dispatch(setCompareA(null));
      dispatch(setCompareB(null));
      return;
    }
    if (!compareAId || !steleRubbings.some((item) => item.id === compareAId)) dispatch(setCompareA(first.id));
    if (second && (!compareBId || !steleRubbings.some((item) => item.id === compareBId))) {
      dispatch(setCompareB(second.id));
    }
  }, [compareAId, compareBId, dispatch, steleRubbings]);

  const rubbingA = steleRubbings.find((item) => item.id === compareAId);
  const rubbingB = steleRubbings.find((item) => item.id === compareBId);
  const diff = useLossDiff(compareAId ?? undefined, compareBId ?? undefined);
  const stele = steles.find((item) => item.id === steleId);

  const selects: FilterSelectConfig[] = [
    {
      key: 'type',
      label: '损泐类型',
      options: LOSS_TYPE_OPTIONS.map((item) => ({ value: item.value, label: item.label })),
    },
  ];

  const lossesOfA = useMemo(
    () => losses.filter((loss) => loss.rubbingId === compareAId),
    [compareAId, losses],
  );
  const lossesOfB = useMemo(
    () => losses.filter((loss) => loss.rubbingId === compareBId),
    [compareBId, losses],
  );

  /** 差异清单按损泐类型与关键字二次筛选（筛选条件写入 URL query） */
  const filteredDiffRows = useMemo(() => {
    const keyword = url.keyword.trim();
    const types = (url.values.type ?? []) as LossType[];
    return diff.diffRows.filter((row) => {
      if (types.length > 0) {
        const typesOfRow = [row.lossA?.type, row.lossB?.type].filter(Boolean) as LossType[];
        if (!typesOfRow.some((type) => types.includes(type))) return false;
      }
      if (keyword.length > 0) {
        const haystack = `${encodeCoord(row.lineNo, row.charNo)}${row.lossA?.note ?? ''}${row.lossB?.note ?? ''}`;
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
  }, [diff.diffRows, url.keyword, url.values]);

  const openCreate = (): void => {
    if (!steleId || !compareAId || !compareBId) {
      message.warning('请先选择碑刻与两个拓本');
      return;
    }
    if (compareAId === compareBId) {
      message.warning('请选择两个不同的拓本进行比对');
      return;
    }
    setEditing(null);
    form.setFieldsValue({
      ...createEmptyCompareDraft(steleId),
      rubbingIdA: compareAId,
      rubbingIdB: compareBId,
      diffCount: diff.diffCount,
      conclusion: diff.suggestedConclusion,
    });
    setOpen(true);
  };

  const openEdit = (compare: Compare): void => {
    setEditing(compare);
    form.setFieldsValue({
      steleId: compare.steleId,
      rubbingIdA: compare.rubbingIdA,
      rubbingIdB: compare.rubbingIdB,
      diffCount: compare.diffCount,
      conclusion: compare.conclusion,
      operator: compare.operator,
      date: compare.date,
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    if (editing) {
      await dispatch(updateCompare({ id: editing.id, patch: values })).unwrap();
      message.success('已更新比对记录');
    } else {
      await dispatch(saveCompare(values)).unwrap();
      message.success(`已保存比对记录：差异 ${values.diffCount} 字，结论「${COMPARE_CONCLUSION_LABEL[values.conclusion]}」`);
    }
    setOpen(false);
  };

  const columns: ColumnsType<Compare> = [
    { title: '比对日期', dataIndex: 'date', width: 120, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: 'A 拓本',
      dataIndex: 'rubbingIdA',
      width: 110,
      render: (value: string) => `第 ${rubbings.find((item) => item.id === value)?.versionNo ?? '?'} 版`,
    },
    {
      title: 'B 拓本',
      dataIndex: 'rubbingIdB',
      width: 110,
      render: (value: string) => `第 ${rubbings.find((item) => item.id === value)?.versionNo ?? '?'} 版`,
    },
    { title: '差异字数', dataIndex: 'diffCount', width: 110, sorter: (a, b) => a.diffCount - b.diffCount },
    {
      title: '断代结论',
      dataIndex: 'conclusion',
      width: 110,
      render: (value: CompareConclusion) => (
        <Tag color={COMPARE_CONCLUSION_COLOR[value]}>{COMPARE_CONCLUSION_LABEL[value]}</Tag>
      ),
    },
    { title: '操作人', dataIndex: 'operator', width: 110, render: (value: string) => value || '未填' },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该比对记录"
            okText="确认"
            cancelText="取消"
            onConfirm={() =>
              void dispatch(removeCompare(record.id))
                .unwrap()
                .then(() => dispatch(loadLosses()))
                .then(() => message.success('已删除'))
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

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>同碑多版本比对与断代</h2>
          <p>选定两个拓本，按字位坐标比对损泐集合并排展示差异，据差异推得早本 / 晚本 / 同版结论。</p>
        </div>
        <Space wrap>
          <Select
            style={{ minWidth: 200 }}
            placeholder="选择碑刻"
            value={steleId || undefined}
            options={steles.map((item) => ({ value: item.id, label: item.title }))}
            onChange={(value: string) => {
              setSteleId(value);
              dispatch(setCurrentStele(value));
            }}
          />
          <Button type="primary" icon={<SaveOutlined />} onClick={openCreate}>
            保存比对记录
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="差异字数" value={diff.diffCount} suffix="字" tone="danger" />
        <StatBadge label="仅 A 拓本" value={diff.result.onlyACount} suffix="字" tone="primary" />
        <StatBadge label="仅 B 拓本" value={diff.result.onlyBCount} suffix="字" tone="warning" />
        <StatBadge label="程度不同" value={diff.result.severityDiffCount} suffix="字" tone="info" />
        <StatBadge label="一致字位" value={diff.result.sameCount} suffix="字" tone="success" />
        <StatBadge label="推断结论" value={COMPARE_CONCLUSION_LABEL[diff.suggestedConclusion]} tone="success" />
      </div>

      <Card size="small" style={{ marginBottom: 14 }}>
        <Space wrap size={12} align="center">
          <Space size={6}>
            <Tag color="#2f3a34">A</Tag>
            <Select
              style={{ minWidth: 180 }}
              value={compareAId ?? undefined}
              placeholder="拓本 A"
              options={steleRubbings.map((item) => ({ value: item.id, label: `第 ${item.versionNo} 版 · ${item.dateGuess || '年代待考'}` }))}
              onChange={(value: string) => dispatch(setCompareA(value))}
            />
          </Space>
          <Button
            size="small"
            icon={<SwapOutlined />}
            onClick={() => {
              dispatch(setCompareA(compareBId));
              dispatch(setCompareB(compareAId));
            }}
          >
            交换
          </Button>
          <Space size={6}>
            <Tag color="#a8623a">B</Tag>
            <Select
              style={{ minWidth: 180 }}
              value={compareBId ?? undefined}
              placeholder="拓本 B"
              options={steleRubbings.map((item) => ({ value: item.id, label: `第 ${item.versionNo} 版 · ${item.dateGuess || '年代待考'}` }))}
              onChange={(value: string) => dispatch(setCompareB(value))}
            />
          </Space>
          <Typography.Text type="secondary">
            A 损泐 {diff.result.totalA} 条 · B 损泐 {diff.result.totalB} 条
          </Typography.Text>
          <Button
            size="small"
            onClick={async () => {
              if (!stele || !rubbingA || !rubbingB) return;
              const ok = await copyText(
                buildDiffText(stele, rubbingA, rubbingB, lossesOfA, lossesOfB),
              );
              if (ok) message.success('差异清单已复制');
              else message.warning('浏览器未授权剪贴板');
            }}
          >
            复制差异清单
          </Button>
        </Space>
      </Card>

      <FilterBar
        keyword={url.keyword}
        onKeywordChange={url.setKeyword}
        selects={selects}
        values={url.values}
        onValuesChange={url.setValues}
        onReset={url.reset}
        keywordPlaceholder="搜索字位坐标 / 备注…"
        actions={<Typography.Text type="secondary">差异 {filteredDiffRows.length} 项</Typography.Text>}
      />

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col xs={24} xl={15}>
          <Card size="small" title="差异字位并排对照">
            {filteredDiffRows.length === 0 ? (
              <EmptyPanel
                title="两个拓本无明显差异"
                description="所有已标注字位的损泐情况一致，可判定为同版；也可继续补充字位标注后再比对。"
                size="small"
              />
            ) : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {filteredDiffRows.map((row) => (
                  <div key={row.key} className="gb-diff-pair">
                    <div className="gb-diff-card is-a">
                      <Space size={6} wrap>
                        <Tag color="#2f3a34">{encodeCoord(row.lineNo, row.charNo)}</Tag>
                        <span>A（第 {rubbingA?.versionNo ?? '?'} 版）</span>
                      </Space>
                      <div style={{ marginTop: 6 }}>
                        {row.lossA ? (
                          <LossTag type={row.lossA.type} severity={row.lossA.severity} note={row.lossA.note} size="small" />
                        ) : (
                          <Typography.Text type="secondary">无损泐（字口完好）</Typography.Text>
                        )}
                      </div>
                    </div>
                    <div className="gb-diff-card is-b">
                      <Space size={6} wrap>
                        <Tag color="#a8623a">{encodeCoord(row.lineNo, row.charNo)}</Tag>
                        <span>B（第 {rubbingB?.versionNo ?? '?'} 版）</span>
                      </Space>
                      <div style={{ marginTop: 6 }}>
                        {row.lossB ? (
                          <LossTag type={row.lossB.type} severity={row.lossB.severity} note={row.lossB.note} size="small" />
                        ) : (
                          <Typography.Text type="secondary">无损泐（字口完好）</Typography.Text>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </Space>
            )}
          </Card>
        </Col>

        <Col xs={24} xl={9}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 14 }}
            message="断代规则"
            description="A 相对 B 多出的损泐说明 A 拓制更晚、石面更损；据此推断早本 / 晚本，差异全为程度不同或方向相反时判为待考。"
          />
          <Card className="gb-table-card" title="比对记录" styles={{ body: { padding: 0 } }}>
            {compares.length === 0 ? (
              <EmptyPanel
                title="还没有比对记录"
                description="完成一次差异比对后点击「保存比对记录」即可归档断代结论。"
                size="small"
              />
            ) : (
              <Table<Compare>
                rowKey="id"
                size="small"
                pagination={{ pageSize: 6 }}
                columns={columns}
                dataSource={compares.filter((compare) => compare.steleId === steleId)}
              />
            )}
          </Card>
        </Col>
      </Row>

      <Modal
        open={open}
        title={editing ? '编辑比对记录' : '保存比对记录'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="conclusion" label="断代结论" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...COMPARE_CONCLUSION_OPTIONS]} />
            </Form.Item>
            <Form.Item name="diffCount" label="差异字数" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="number" min={0} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="operator" label="操作人" style={{ flex: 1 }}>
              <Input placeholder="如：傅砚" />
            </Form.Item>
            <Form.Item name="date" label="比对日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
          </Space>
          <Alert
            type="success"
            showIcon
            message={`系统推断结论：${COMPARE_CONCLUSION_LABEL[diff.suggestedConclusion]}（差异 ${diff.diffCount} 字）`}
            description="可在此基础上人工复核后修改。"
          />
          <Form.Item name="rubbingIdA" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="rubbingIdB" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="steleId" hidden>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
