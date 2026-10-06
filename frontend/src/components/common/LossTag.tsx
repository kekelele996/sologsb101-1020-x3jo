/**
 * <LossTag> 损泐字位标签
 * 按缺字 / 裂痕 / 漫漶 / 石花与轻中重渲染底色，并可附带字位坐标；
 * 被碑刻页、字位页与比对页消费。
 */
import { Tag, Tooltip } from 'antd';
import {
  LOSS_SEVERITY_COLOR,
  LOSS_SEVERITY_LABEL,
  LOSS_TYPE_COLOR,
  LOSS_TYPE_LABEL,
  type LossSeverity,
  type LossType,
} from '@/types/loss';
import { encodeCoord } from '@/utils/collate';

export interface LossTagProps {
  type: LossType;
  severity?: LossSeverity;
  /** 字位坐标（行号 / 字位），传入后显示 L03C07 */
  lineNo?: number;
  charNo?: number;
  /** 释文备注，作为悬浮提示 */
  note?: string;
  size?: 'default' | 'small';
}

export function LossTag({ type, severity, lineNo, charNo, note, size = 'default' }: LossTagProps) {
  const color = LOSS_TYPE_COLOR[type];
  const coord = lineNo !== undefined && charNo !== undefined ? encodeCoord(lineNo, charNo) : '';
  const text = `${coord ? `${coord} ` : ''}${LOSS_TYPE_LABEL[type]}${severity ? `·${LOSS_SEVERITY_LABEL[severity]}` : ''}`;

  const tag = (
    <Tag
      color={color}
      style={{
        marginInlineEnd: 4,
        fontSize: size === 'small' ? 12 : undefined,
        borderStyle: severity === 'heavy' ? 'dashed' : 'solid',
      }}
    >
      {text}
      {severity ? (
        <span style={{ marginInlineStart: 4, color: LOSS_SEVERITY_COLOR[severity] }}>●</span>
      ) : null}
    </Tag>
  );

  return note ? <Tooltip title={note}>{tag}</Tooltip> : tag;
}

export default LossTag;
