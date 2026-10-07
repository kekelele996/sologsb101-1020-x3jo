/**
 * 柜层（ShelfTier）数据模型
 * 库房柜位的一层。每层能摆几个装具是定死的（槽位上限），
 * 当前层槽位放满后自动在同一柜位开新一层，再满则换下一个柜位。
 */

/** 柜位编号：A、B、C…… 与层号组合成柜层号 A-1、A-2…… */
export const FIRST_CABINET_NO = 'A';

/** 每个柜位固定层数，超过后柜位号向后进位（A-5 → B-1） */
export const TIERS_PER_CABINET = 5;

export interface ShelfTier {
  id: string;
  /** 柜层号，如 A-1（柜位 A 第 1 层） */
  code: string;
  /** 柜位号，如 A */
  cabinetNo: string;
  /** 层号，从 1 起 */
  tierNo: number;
  /** 本层固定可摆放装具数（槽位定死） */
  slotCapacity: number;
  createdAt: number;
  updatedAt: number;
}

export type ShelfTierDraft = Omit<ShelfTier, 'id' | 'createdAt' | 'updatedAt'>;

/** 每层槽位上限：一层固定摆 4 个装具 */
export const TIER_SLOT_CAPACITY = 4;

/** 柜位号进位：A → B → …… → Z（馆藏规模内够用） */
export function cabinetNoAt(index: number): string {
  return String.fromCharCode(FIRST_CABINET_NO.charCodeAt(0) + index);
}

/** 柜层号：柜位 + 层号，如 A-1 */
export function tierCodeOf(cabinetNo: string, tierNo: number): string {
  return `${cabinetNo}-${tierNo}`;
}

/** 柜层可读文案，如「A 柜第 1 层」 */
export function describeShelfTier(cabinetNo: string, tierNo: number): string {
  return `${cabinetNo} 柜第 ${tierNo} 层`;
}
