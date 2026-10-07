/**
 * 排架入库流水（ShelfIntake）数据模型
 * 库房排架账逐行登记的入库记录：收藏号 + 库房实测尺寸。
 * - 认不出对应拓本的收藏号先单独记账，状态「待认领」，等人认领后再上架；
 * - 尺寸对不上时以库房实测为准回写编目台尺寸（拓法、损泐字位不动），
 *   编目原记留在 catalogSizeAtIntake 备查；
 * - 装具写库失败的行随该装具挂起，只重试这一个装具，编目台照旧不动。
 */

/** 入库流水状态：已上架 / 待认领 / 待上架（尺寸分不上）/ 写库失败挂起 / 重复入库 */
export type ShelfIntakeStatus = 'shelved' | 'pendingClaim' | 'pendingShelf' | 'writeFailed' | 'duplicate';

/** 入库来源：库房逐件入库 / 旧藏升级时按尺寸粗分 */
export type ShelfIntakeSource = 'intake' | 'legacySplit';

export interface ShelfIntake {
  id: string;
  /** 库房排架账上登记的收藏号原文 */
  collectionNo: string;
  /** 认领上的编目台拓本 id；认不出时为 null */
  rubbingId: string | null;
  /** 库房实测尺寸原文，如 210×88（排架与编目台尺寸的唯一准绳） */
  measuredSize: string;
  /** 入库当时编目台登记的尺寸（尺寸改记后留痕）；未登记为空串 */
  catalogSizeAtIntake: string;
  /** 入库时是否发生过「以库房实测为准」的尺寸改记 */
  reconciled: boolean;
  status: ShelfIntakeStatus;
  /** 落入的装具 id；待认领 / 待上架时为 null */
  containerId: string | null;
  /** 入库批次号，如 PC-20261007-01（同一天逐批递增） */
  batchNo: string;
  /** 写库尝试次数（随装具重试累加） */
  attempts: number;
  /** 写库失败原因或人工备注 */
  lastWriteError: string;
  source: ShelfIntakeSource;
  /** 释文式备注：留待上架原因、认领说明等 */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type ShelfIntakeDraft = Omit<ShelfIntake, 'id' | 'createdAt' | 'updatedAt'>;

export const SHELF_INTAKE_STATUS_LABEL: Record<ShelfIntakeStatus, string> = {
  shelved: '已上架',
  pendingClaim: '待认领',
  pendingShelf: '待上架',
  writeFailed: '写库失败',
  duplicate: '重复入库',
};

export const SHELF_INTAKE_STATUS_COLOR: Record<ShelfIntakeStatus, string> = {
  shelved: '#2f6f4f',
  pendingClaim: '#c9963c',
  pendingShelf: '#3f5d6b',
  writeFailed: '#b03a2e',
  duplicate: '#8c8c8c',
};

export const SHELF_INTAKE_SOURCE_LABEL: Record<ShelfIntakeSource, string> = {
  intake: '库房入库',
  legacySplit: '旧藏升级粗分',
};
