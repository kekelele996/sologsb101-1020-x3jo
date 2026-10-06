/**
 * 版本比对（Compare）数据模型
 * 同一碑刻下两份拓本的损泐差异清单与断代结论。
 */

/** 断代结论：早本 / 晚本 / 同版 / 待考 */
export type CompareConclusion = 'early' | 'late' | 'same' | 'pending';

export interface Compare {
  id: string;
  /** 所属碑刻 id */
  steleId: string;
  /** 拓本 A id */
  rubbingIdA: string;
  /** 拓本 B id */
  rubbingIdB: string;
  /** 差异字数 */
  diffCount: number;
  /** 断代结论 */
  conclusion: CompareConclusion;
  /** 操作人 */
  operator: string;
  /** 比对日期 yyyy-MM-dd */
  date: string;
  createdAt: number;
  updatedAt: number;
}

export type CompareDraft = Omit<Compare, 'id' | 'createdAt' | 'updatedAt'>;

export const COMPARE_CONCLUSION_LABEL: Record<CompareConclusion, string> = {
  early: '早本',
  late: '晚本',
  same: '同版',
  pending: '待考',
};

export const COMPARE_CONCLUSION_COLOR: Record<CompareConclusion, string> = {
  early: '#2f6f4f',
  late: '#a8623a',
  same: '#3f5d6b',
  pending: '#8c8c8c',
};

export const COMPARE_CONCLUSION_OPTIONS: ReadonlyArray<{ value: CompareConclusion; label: string }> = [
  { value: 'early', label: '早本' },
  { value: 'late', label: '晚本' },
  { value: 'same', label: '同版' },
  { value: 'pending', label: '待考' },
];

export function createEmptyCompareDraft(steleId: string): CompareDraft {
  return {
    steleId,
    rubbingIdA: '',
    rubbingIdB: '',
    diffCount: 0,
    conclusion: 'pending',
    operator: '',
    date: new Date().toISOString().slice(0, 10),
  };
}
