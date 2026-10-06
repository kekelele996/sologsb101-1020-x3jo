/**
 * 拓本（Rubbing）数据模型
 * 同一碑刻下的不同拓本：拓法、纸墨、尺寸、收藏号与年代判断，自动生成版本序号。
 */

/** 拓法：擦拓 / 扑拓 / 蝉翼拓 */
export type RubbingMethod = 'rub' | 'pat' | 'cicada';

/** 墨色：浓墨 / 淡墨 */
export type InkTone = 'thick' | 'light';

/** 状态：待编目 / 已编目 / 待比对 */
export type RubbingState = 'toCatalog' | 'cataloged' | 'toCompare';

export interface Rubbing {
  id: string;
  /** 所属碑刻 id */
  steleId: string;
  /** 同一碑刻下的版本序号，从 1 开始，自动生成 */
  versionNo: number;
  /** 拓法 */
  method: RubbingMethod;
  /** 纸种 */
  paperType: string;
  /** 墨色 */
  inkTone: InkTone;
  /** 尺寸（厘米） */
  sizeCm: string;
  /** 收藏号 */
  collectionNo: string;
  /** 年代判断 */
  dateGuess: string;
  /** 状态 */
  state: RubbingState;
  createdAt: number;
  updatedAt: number;
}

export type RubbingDraft = Omit<Rubbing, 'id' | 'createdAt' | 'updatedAt'>;

export const RUBBING_METHOD_LABEL: Record<RubbingMethod, string> = {
  rub: '擦拓',
  pat: '扑拓',
  cicada: '蝉翼拓',
};

export const RUBBING_METHOD_OPTIONS: ReadonlyArray<{ value: RubbingMethod; label: string }> = [
  { value: 'rub', label: '擦拓' },
  { value: 'pat', label: '扑拓' },
  { value: 'cicada', label: '蝉翼拓' },
];

export const INK_TONE_LABEL: Record<InkTone, string> = {
  thick: '浓墨',
  light: '淡墨',
};

export const INK_TONE_OPTIONS: ReadonlyArray<{ value: InkTone; label: string }> = [
  { value: 'thick', label: '浓墨' },
  { value: 'light', label: '淡墨' },
];

export const RUBBING_STATE_LABEL: Record<RubbingState, string> = {
  toCatalog: '待编目',
  cataloged: '已编目',
  toCompare: '待比对',
};

export const RUBBING_STATE_COLOR: Record<RubbingState, string> = {
  toCatalog: '#8c8c8c',
  cataloged: '#2f6f4f',
  toCompare: '#c9963c',
};

export const RUBBING_STATE_OPTIONS: ReadonlyArray<{ value: RubbingState; label: string }> = [
  { value: 'toCatalog', label: '待编目' },
  { value: 'cataloged', label: '已编目' },
  { value: 'toCompare', label: '待比对' },
];

export const RUBBING_STATE_FLOW: readonly RubbingState[] = ['toCatalog', 'cataloged', 'toCompare'];

export function nextRubbingState(state: RubbingState): RubbingState {
  const index = RUBBING_STATE_FLOW.indexOf(state);
  if (index < 0 || index >= RUBBING_STATE_FLOW.length - 1) return state;
  return RUBBING_STATE_FLOW[index + 1] as RubbingState;
}

export const PAPER_TYPE_OPTIONS: readonly string[] = ['宣纸', '棉连纸', '皮纸', '罗纹纸', '净皮宣'];

export function createEmptyRubbingDraft(steleId: string, versionNo: number): RubbingDraft {
  return {
    steleId,
    versionNo,
    method: 'rub',
    paperType: '宣纸',
    inkTone: 'thick',
    sizeCm: '',
    collectionNo: '',
    dateGuess: '',
    state: 'toCatalog',
  };
}
