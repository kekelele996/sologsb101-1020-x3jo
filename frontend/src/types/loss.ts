/**
 * 损泐字位（Loss）数据模型
 * 按行号 + 字位坐标标注的损泐情况，是同碑多版本比对的比对单元。
 */

/** 损泐类型：缺字 / 裂痕 / 漫漶 / 石花 */
export type LossType = 'missing' | 'crack' | 'blur' | 'stoneFlower';

/** 严重程度：轻 / 中 / 重 */
export type LossSeverity = 'light' | 'medium' | 'heavy';

export interface Loss {
  id: string;
  /** 所属拓本 id */
  rubbingId: string;
  /** 行号，从 1 开始 */
  lineNo: number;
  /** 字位，行内第几字，从 1 开始 */
  charNo: number;
  /** 损泐类型 */
  type: LossType;
  /** 严重程度 */
  severity: LossSeverity;
  /** 释文备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type LossDraft = Omit<Loss, 'id' | 'createdAt' | 'updatedAt'>;

export const LOSS_TYPE_LABEL: Record<LossType, string> = {
  missing: '缺字',
  crack: '裂痕',
  blur: '漫漶',
  stoneFlower: '石花',
};

export const LOSS_TYPE_COLOR: Record<LossType, string> = {
  missing: '#b03a2e',
  crack: '#a8623a',
  blur: '#7a6a4f',
  stoneFlower: '#3f5d6b',
};

export const LOSS_SEVERITY_LABEL: Record<LossSeverity, string> = {
  light: '轻',
  medium: '中',
  heavy: '重',
};

export const LOSS_SEVERITY_COLOR: Record<LossSeverity, string> = {
  light: '#8fa88f',
  medium: '#c9963c',
  heavy: '#b03a2e',
};

export const LOSS_TYPE_OPTIONS: ReadonlyArray<{ value: LossType; label: string }> = [
  { value: 'missing', label: '缺字' },
  { value: 'crack', label: '裂痕' },
  { value: 'blur', label: '漫漶' },
  { value: 'stoneFlower', label: '石花' },
];

export const LOSS_SEVERITY_OPTIONS: ReadonlyArray<{ value: LossSeverity; label: string }> = [
  { value: 'light', label: '轻' },
  { value: 'medium', label: '中' },
  { value: 'heavy', label: '重' },
];

export function createEmptyLossDraft(rubbingId: string, lineNo: number, charNo: number): LossDraft {
  return {
    rubbingId,
    lineNo,
    charNo,
    type: 'missing',
    severity: 'medium',
    note: '',
  };
}
