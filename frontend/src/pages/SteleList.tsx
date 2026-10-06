/**
 * /steles 碑刻与所在地台账
 * 新建碑刻、按年代与形制筛选（同步 URL query），卡片回显已收拓本数与版本差异条数。
 * 消费 Stele、Rubbing、Loss、Compare；复用 <LossTag>、<EmptyPanel>、<StatBadge>、<FilterBar>。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
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
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, RightCircleOutlined } from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import LossTag from '@/components/common/LossTag';
import StatBadge from '@/components/common/StatBadge';
import { useIdbTable } from '@/hooks/useIdbTable';
import { ROUTES } from '@/router';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  createStele,
  loadSteles,
  removeStele,
  resetSteleFilters,
  selectEraOptions,
  selectFilteredSteles,
  selectSteles,
  setCurrentStele,
  setSteleEras,
  setSteleForms,
  setSteleKeyword,
  updateStele,
} from '@/stores/steleSlice';
import {
  selectRubbings,
  setRubbingSteleFilter,
} from '@/stores/rubbingSlice';
import { selectCompares, selectLosses } from '@/stores/lossSlice';
import {
  STELE_FORM_COLOR,
  STELE_FORM_LABEL,
  STELE_FORM_OPTIONS,
  createEmptySteleDraft,
  type Stele,
  type SteleDraft,
  type SteleForm,
} from '@/types/stele';
import { COMPARE_CONCLUSION_LABEL } from '@/types/compare';
import type { Seal } from '@/types/seal';

const FILTER_KEYS = ['era', 'form'] as const;

export default function SteleList() {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const [form] = Form.useForm<SteleDraft>();

  const steles = useAppSelector(selectSteles);
  const filtered = useAppSelector(selectFilteredSteles);
  const eraOptions = useAppSelector(selectEraOptions);
  const currentSteleId = useAppSelector((state) => state.stele.currentSteleId);
  const rubbings = useAppSelector(selectRubbings);
  const losses = useAppSelector(selectLosses);
  const compares = useAppSelector(selectCompares);
  const sealTable = useIdbTable<Seal>((database) => database.seals, { sortByUpdatedAt: false });

  const url = useFilterQuery(FILTER_KEYS);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Stele | null>(null);

  // URL query → Redux 筛选条件（URL 为唯一事实来源）
  useEffect(() => {
    dispatch(setSteleKeyword(url.keyword));
    dispatch(setSteleEras(url.values.era ?? []));
    dispatch(setSteleForms((url.values.form ?? []) as SteleForm[]));
  }, [dispatch, url.keyword, url.values]);

  const selects: FilterSelectConfig[] = useMemo(
    () => [
      { key: 'era', label: '年代', options: eraOptions.map((era) => ({ value: era, label: era })) },
      { key: 'form', label: '形制', options: STELE_FORM_OPTIONS.map((item) => ({ value: item.value, label: item.label })) },
    ],
    [eraOptions],
  );

  const statOfStele = (
    steleId: string,
  ): { rubbings: number; diff: number; loss: number; seal: number; conclusion: string } => {
    const steleRubbings = rubbings.filter((rubbing) => rubbing.steleId === steleId);
    const rubbingIds = steleRubbings.map((rubbing) => rubbing.id);
    const steleCompares = compares.filter((compare) => compare.steleId === steleId);
    const lastCompare = [...steleCompares].sort((a, b) => b.date.localeCompare(a.date))[0];
    return {
      rubbings: steleRubbings.length,
      diff: steleCompares.reduce((sum, compare) => sum + compare.diffCount, 0),
      loss: losses.filter((loss) => rubbingIds.includes(loss.rubbingId)).length,
      seal: sealTable.rows.filter((seal) => rubbingIds.includes(seal.rubbingId)).length,
      conclusion: lastCompare
        ? `${COMPARE_CONCLUSION_LABEL[lastCompare.conclusion]}（${lastCompare.date}）`
        : '尚无比对',
    };
  };

  const totals = useMemo(
    () => ({
      steles: steles.length,
      rubbings: rubbings.length,
      losses: losses.length,
      diff: compares.reduce((sum, compare) => sum + compare.diffCount, 0),
      catalogedPercent:
        rubbings.length === 0
          ? 0
          : Math.round((rubbings.filter((rubbing) => rubbing.state === 'cataloged').length / rubbings.length) * 100),
    }),
    [compares, losses.length, rubbings, steles.length],
  );

  const openCreate = (): void => {
    setEditing(null);
    form.setFieldsValue(createEmptySteleDraft());
    setOpen(true);
  };

  const openEdit = (stele: Stele): void => {
    setEditing(stele);
    form.setFieldsValue({
      title: stele.title,
      era: stele.era,
      location: stele.location,
      form: stele.form,
      sizeCm: stele.sizeCm,
      calligrapher: stele.calligrapher,
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    if (editing) {
      await dispatch(updateStele({ id: editing.id, patch: values })).unwrap();
      message.success(`已更新《${values.title}》`);
    } else {
      const created = await dispatch(createStele(values)).unwrap();
      dispatch(setCurrentStele(created.id));
      message.success(`已新建碑刻《${created.title}》，可登记拓本`);
    }
    setOpen(false);
  };

  const handleRemove = async (stele: Stele): Promise<void> => {
    await dispatch(removeStele(stele.id)).unwrap();
    await dispatch(loadSteles());
    message.success(`已删除《${stele.title}》及其拓本、损泐与比对记录`);
  };

  const goRubbings = (stele: Stele): void => {
    dispatch(setCurrentStele(stele.id));
    dispatch(setRubbingSteleFilter(stele.id));
    navigate(ROUTES.rubbings);
  };

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>碑刻与所在地台账</h2>
          <p>登记碑名、年代、所在地与形制；卡片回显已收拓本数、损泐字位数与最近断代结论。</p>
        </div>
        <Space>
          <Button onClick={() => navigate(ROUTES.compare)}>前往版本比对</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建碑刻
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="碑刻总数" value={totals.steles} suffix="处" tone="primary" />
        <StatBadge label="拓本总数" value={totals.rubbings} suffix="份" tone="info" />
        <StatBadge label="损泐字位" value={totals.losses} suffix="条" tone="warning" />
        <StatBadge label="累计差异字数" value={totals.diff} suffix="字" tone="danger" />
        <StatBadge label="已编目占比" value={`${totals.catalogedPercent}%`} percent={totals.catalogedPercent} tone="success" />
      </div>

      <FilterBar
        keyword={url.keyword}
        onKeywordChange={url.setKeyword}
        selects={selects}
        values={url.values}
        onValuesChange={url.setValues}
        onReset={() => {
          url.reset();
          dispatch(resetSteleFilters());
        }}
        keywordPlaceholder="搜索碑名 / 年代 / 所在地 / 书者…"
        actions={
          <Typography.Text type="secondary">
            共 {filtered.length} / {steles.length} 处
          </Typography.Text>
        }
      />

      <div style={{ marginTop: 16 }}>
        {filtered.length === 0 ? (
          <EmptyPanel
            title={steles.length === 0 ? '还没有登记任何碑刻' : '当前筛选条件下没有碑刻'}
            description={
              steles.length === 0
                ? '先登记一处碑刻的年代、所在地与形制，再逐份登记拓本与损泐字位。'
                : '试着放宽年代或形制条件，或重置筛选。'
            }
            actionText="新建碑刻"
            onAction={openCreate}
            secondaryText="重置筛选"
            onSecondary={() => url.reset()}
          />
        ) : (
          <Row gutter={[16, 16]}>
            {filtered.map((stele) => {
              const stat = statOfStele(stele.id);
              return (
                <Col key={stele.id} xs={24} md={12} xl={8}>
                  <Card
                    className={`gb-body-card${currentSteleId === stele.id ? ' is-active' : ''}`}
                    title={
                      <Space size={6} wrap>
                        <Tag color={STELE_FORM_COLOR[stele.form]}>{STELE_FORM_LABEL[stele.form]}</Tag>
                        <Typography.Text strong>{stele.title}</Typography.Text>
                      </Space>
                    }
                    extra={
                      <Button type="link" size="small" icon={<RightCircleOutlined />} onClick={() => goRubbings(stele)}>
                        拓本
                      </Button>
                    }
                    onClick={() => dispatch(setCurrentStele(stele.id))}
                  >
                    <Space direction="vertical" size={6} style={{ width: '100%' }}>
                      <Space size={6} wrap>
                        <Tag>{stele.era || '年代待考'}</Tag>
                        <Tag color="gold">{stele.sizeCm || '尺寸未记'}</Tag>
                      </Space>
                      <Typography.Text type="secondary">所在地：{stele.location || '未记'}</Typography.Text>
                      <Typography.Text type="secondary">书者：{stele.calligrapher || '佚名'}</Typography.Text>
                      <Typography.Text>
                        已收拓本 <strong>{stat.rubbings}</strong> 份 · 损泐字位 {stat.loss} 条
                      </Typography.Text>
                      <Typography.Text>
                        版本差异 <strong>{stat.diff}</strong> 字 · 钤印 {stat.seal} 方
                      </Typography.Text>
                      <Typography.Text type="secondary">最近断代：{stat.conclusion}</Typography.Text>
                      <Space size={4} wrap>
                        {losses
                          .filter((loss) => rubbings.some((rubbing) => rubbing.id === loss.rubbingId && rubbing.steleId === stele.id))
                          .slice(0, 3)
                          .map((loss) => (
                            <LossTag
                              key={loss.id}
                              type={loss.type}
                              severity={loss.severity}
                              lineNo={loss.lineNo}
                              charNo={loss.charNo}
                              note={loss.note}
                              size="small"
                            />
                          ))}
                        {stat.loss > 3 ? <Tag>+{stat.loss - 3}</Tag> : null}
                      </Space>
                      <Space size={4} wrap onClick={(event) => event.stopPropagation()}>
                        <Button size="small" onClick={() => goRubbings(stele)}>
                          登记拓本
                        </Button>
                        <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(stele)}>
                          编辑
                        </Button>
                        <Popconfirm
                          title="删除碑刻"
                          description="将同时删除其拓本、损泐字位、钤印与比对记录，不可恢复。"
                          okText="确认删除"
                          cancelText="取消"
                          onConfirm={() => void handleRemove(stele)}
                        >
                          <Button size="small" danger icon={<DeleteOutlined />}>
                            删除
                          </Button>
                        </Popconfirm>
                      </Space>
                    </Space>
                  </Card>
                </Col>
              );
            })}
          </Row>
        )}
      </div>

      <Modal
        open={open}
        title={editing ? `编辑《${editing.title}》` : '新建碑刻'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="title" label="碑名" rules={[{ required: true, message: '请填写碑名' }]}>
            <Input placeholder="如：礼器碑" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="era" label="年代" style={{ flex: 1 }}>
              <Input placeholder="如：东汉永寿二年" />
            </Form.Item>
            <Form.Item name="form" label="形制" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...STELE_FORM_OPTIONS]} />
            </Form.Item>
          </Space>
          <Form.Item name="location" label="所在地">
            <Input placeholder="如：山东曲阜孔庙" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="sizeCm" label="尺寸（厘米）" style={{ flex: 1 }}>
              <Input placeholder="如：227×93" />
            </Form.Item>
            <Form.Item name="calligrapher" label="书者" style={{ flex: 1 }}>
              <Input placeholder="如：颜真卿（楷书）" />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
