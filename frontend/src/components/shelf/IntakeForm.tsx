/**
 * 库房入库表单：把排架账逐行录入编目台。
 * 每行「收藏号 库房实测尺寸」（空白或逗号分隔），如：TB-0303 207×86。
 * 认不出的收藏号自动落到「待认领」；尺寸对不上以库房实测为准。
 * 演练开关用于演示「写库失败后只重试这一个装具」。
 */
import { useState } from 'react';
import { App as AntdApp, Alert, Button, Radio, Space, Table, Tag, Typography } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { runIntakeBatch, type IntakeOptions } from '@/stores/shelfSlice';
import { useAppDispatch } from '@/stores/store';
import { CONTAINER_SIZE_LIMIT_CM } from '@/types/container';
import { TIER_SLOT_CAPACITY } from '@/types/shelfTier';
import { parseSizeCm } from '@/utils/shelving';

interface ParsedLine {
  key: number;
  raw: string;
  collectionNo: string;
  measuredSize: string;
  valid: boolean;
}

const PLACEHOLDER = ['TB-0303 207×86', 'TB-0304 260×92', 'TB-0998 188×96'].join('\n');

/** 解析一行排架账：收藏号 + 尺寸，分隔符为空白 / 逗号 / 制表符 */
export function parseIntakeText(text: string): ParsedLine[] {
  return text
    .split(/\r?\n/)
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0)
    .map((raw, index) => {
      const matched = /^([^\s,，]+)[\s,，]+(.+)$/.exec(raw);
      if (!matched) return { key: index, raw, collectionNo: '', measuredSize: '', valid: false };
      const collectionNo = (matched[1] as string).trim();
      const measuredSize = (matched[2] as string).trim();
      return { key: index, raw, collectionNo, measuredSize, valid: collectionNo.length > 0 };
    });
}

export default function IntakeForm() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failureMode, setFailureMode] = useState<'none' | 'transient' | 'persistent'>('none');

  const parsed = parseIntakeText(text);
  const validLines = parsed.filter((line) => line.valid);

  const previewColumns: ColumnsType<ParsedLine> = [
    { title: '收藏号', dataIndex: 'collectionNo', width: 130, render: (value: string) => value || <Tag color="error">无法解析</Tag> },
    {
      title: '库房实测尺寸',
      dataIndex: 'measuredSize',
      render: (value: string) => {
        const parsedSize = parseSizeCm(value);
        return (
          <Space size={6}>
            <span>{value || '—'}</span>
            {parsedSize.longEdge !== null ? <Tag>长边 {parsedSize.longEdge}cm</Tag> : null}
          </Space>
        );
      },
    },
  ];

  const handleSubmit = async (): Promise<void> => {
    if (validLines.length === 0) {
      message.warning('请先按「收藏号 尺寸」每行一条录入排架账');
      return;
    }
    const options: IntakeOptions = {
      simulateTransientFailure: failureMode === 'transient',
      simulatePersistentFailure: failureMode === 'persistent',
    };
    setSubmitting(true);
    try {
      const result = await dispatch(
        runIntakeBatch({
          lines: validLines.map((line) => ({ collectionNo: line.collectionNo, measuredSize: line.measuredSize })),
          options,
        }),
      ).unwrap();
      message.success(
        `批次 ${result.batchNo} 入库：已上架 ${result.shelved}，新建装具 ${result.createdContainerCodes.length} 个` +
          (result.reconciled > 0 ? `，以库房实测改记尺寸 ${result.reconciled} 条` : '') +
          (result.pendingClaim > 0 ? `，待认领 ${result.pendingClaim}` : '') +
          (result.pendingShelf > 0 ? `，待上架 ${result.pendingShelf}` : '') +
          (result.writeFailed > 0 ? `，写库失败挂起 ${result.writeFailed} 条` : '') +
          (result.duplicate > 0 ? `，重复入库 ${result.duplicate} 条` : ''),
      );
      setText('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="排架规则"
        description={
          <Typography.Text style={{ fontSize: 12 }}>
            装具尺寸合计上限 {CONTAINER_SIZE_LIMIT_CM}cm（按拓本长边累加，放不下另起装具）；柜位每层固定 {TIER_SLOT_CAPACITY}{' '}
            个装具槽位，满层自动开新层。尺寸与编目台不符时以库房实测为准回写，拓法与损泐字位不动。
          </Typography.Text>
        }
      />
      <textarea
        className="gb-intake-textarea"
        placeholder={PLACEHOLDER}
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={5}
      />
      {parsed.length > 0 ? (
        <Table<ParsedLine>
          rowKey="key"
          size="small"
          pagination={false}
          columns={previewColumns}
          dataSource={parsed}
          scroll={{ y: 160 }}
        />
      ) : null}
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Radio.Group
          size="small"
          value={failureMode}
          onChange={(event) => setFailureMode(event.target.value as 'none' | 'transient' | 'persistent')}
          optionType="button"
          buttonStyle="solid"
          options={[
            { value: 'none', label: '正常写库' },
            { value: 'transient', label: '演练：瞬时失败' },
            { value: 'persistent', label: '演练：持续失败' },
          ]}
        />
        <Button type="primary" icon={<InboxOutlined />} loading={submitting} onClick={() => void handleSubmit()}>
          按排架账入库（{validLines.length} 条）
        </Button>
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        「瞬时失败」演示装具自动重试后成功；「持续失败」演示只重试这一个装具、耗尽后挂起到「写库失败」区手动再试，编目台数据不动。
      </Typography.Text>
    </Space>
  );
}
