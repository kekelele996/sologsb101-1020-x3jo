/**
 * 钤印（Seal）数据模型
 * 拓本上的收藏印 / 鉴赏印 / 作者印，按位置排序展示，可批量调整印别。
 */

/** 印别：收藏印 / 鉴赏印 / 作者印 */
export type SealType = 'collection' | 'appraisal' | 'author';

export interface Seal {
  id: string;
  /** 所属拓本 id */
  rubbingId: string;
  /** 印文 */
  sealText: string;
  /** 位置，如「右下角」 */
  position: string;
  /** 释文 */
  transcription: string;
  /** 印别 */
  sealType: SealType;
  createdAt: number;
  updatedAt: number;
}

export type SealDraft = Omit<Seal, 'id' | 'createdAt' | 'updatedAt'>;

export const SEAL_TYPE_LABEL: Record<SealType, string> = {
  collection: '收藏印',
  appraisal: '鉴赏印',
  author: '作者印',
};

export const SEAL_TYPE_COLOR: Record<SealType, string> = {
  collection: '#a33a2c',
  appraisal: '#3f5d6b',
  author: '#2f6f4f',
};

export const SEAL_TYPE_OPTIONS: ReadonlyArray<{ value: SealType; label: string }> = [
  { value: 'collection', label: '收藏印' },
  { value: 'appraisal', label: '鉴赏印' },
  { value: 'author', label: '作者印' },
];

/** 位置候选：登记后按此顺序排序展示 */
export const SEAL_POSITION_OPTIONS: readonly string[] = [
  '右下角',
  '左下角',
  '右上角',
  '左上角',
  '卷首',
  '卷尾',
  '骑缝',
];

export function sealPositionWeight(position: string): number {
  const index = SEAL_POSITION_OPTIONS.indexOf(position);
  return index < 0 ? SEAL_POSITION_OPTIONS.length : index;
}

export function createEmptySealDraft(rubbingId: string): SealDraft {
  return {
    rubbingId,
    sealText: '',
    position: '右下角',
    transcription: '',
    sealType: 'collection',
  };
}
