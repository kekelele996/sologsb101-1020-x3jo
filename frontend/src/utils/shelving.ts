/**
 * 排架纯逻辑
 * - 拓本尺寸解析（"210×88" → 长边厘米数）
 * - 库房顺次装箱：一个装具尺寸合计有上限，放不下的另起一个
 * - 柜层槽位预排：每层槽位定死，满层开新层、再满换柜
 * - 旧藏升级按尺寸粗分档
 * 均为无副作用纯函数；Dexie 读写与「以库房实测为准」的回写编排在 utils/db.ts。
 */
import {
  CONTAINER_SIZE_LIMIT_CM,
  type Container,
  type ContainerItem,
} from '@/types/container';
import {
  TIERS_PER_CABINET,
  TIER_SLOT_CAPACITY,
  cabinetNoAt,
  tierCodeOf,
  type ShelfTier,
} from '@/types/shelfTier';

/** 尺寸串解析结果 */
export interface ParsedSize {
  /** 长边（厘米），解析失败为 null */
  longEdge: number | null;
  /** 短边（厘米） */
  shortEdge: number | null;
  /** 去空白后的原文 */
  raw: string;
}

/**
 * 解析形如 210×88 / 210x88 / 210*88 cm 的尺寸串。
 * 排架只按长边（较大边）计入装具尺寸合计。
 */
export function parseSizeCm(input: string): ParsedSize {
  const raw = input.trim();
  const matched = /^(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)/.exec(raw.replace(/cm/i, '').trim());
  if (!matched) return { longEdge: null, shortEdge: null, raw };
  const a = Number.parseFloat(matched[1] as string);
  const b = Number.parseFloat(matched[2] as string);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    return { longEdge: null, shortEdge: null, raw };
  }
  return { longEdge: Math.max(a, b), shortEdge: Math.min(a, b), raw };
}

/** 待排架条目：按行入库流水的最小信息 */
export interface ShelfPackEntry {
  /** 行键（用 ShelfIntake.id），用于把结果回贴到流水 */
  key: string;
  rubbingId: string;
  sizeCm: string;
  lengthCm: number;
}

export interface PackedGroup {
  /** 是否续用当前在用装具（仅第一组且调用方传入在用装具时为 true） */
  reuseActive: boolean;
  /** 装入本装具的条目 */
  entries: ShelfPackEntry[];
  /** 本装具合计长边（厘米） */
  usedSizeCm: number;
}

export interface PackShelfResult {
  groups: PackedGroup[];
  /** 单个尺寸就超过装具上限、分不上装具的条目（留待上架） */
  overflow: ShelfPackEntry[];
}

/**
 * 库房顺次装箱（next-fit）：
 * 依次往当前装具放；当前装具（含调用方传入的在用装具）放不下就另起一个；
 * 单件尺寸超过空装具上限的，任何装具都放不下，归入 overflow 留待上架。
 */
export function packShelfEntries(
  entries: ShelfPackEntry[],
  activeContainer: Pick<Container, 'usedSizeCm'> | null,
  sizeLimitCm: number = CONTAINER_SIZE_LIMIT_CM,
): PackShelfResult {
  const groups: PackedGroup[] = [];
  const overflow: ShelfPackEntry[] = [];
  // 续用当前在用装具时，先建一个复用分组占位；最终若无新条目会被过滤掉
  let current: PackedGroup | null = activeContainer
    ? { reuseActive: true, entries: [], usedSizeCm: activeContainer.usedSizeCm }
    : null;
  if (current) groups.push(current);

  entries.forEach((entry) => {
    if (entry.lengthCm > sizeLimitCm) {
      overflow.push(entry);
      return;
    }
    if (current === null) {
      current = { reuseActive: false, entries: [], usedSizeCm: 0 };
      groups.push(current);
    } else if (current.usedSizeCm + entry.lengthCm > sizeLimitCm) {
      // 当前装具放不下 → 另起一个新装具
      current = { reuseActive: false, entries: [], usedSizeCm: 0 };
      groups.push(current);
    }
    current.entries.push(entry);
    current.usedSizeCm += entry.lengthCm;
  });

  // 续用在装箱的分组本身可能没有新条目（条目都进了后续新箱），只保留实际装入的分组
  return { groups: groups.filter((group) => group.entries.length > 0), overflow };
}

/** 某新装具应落入的柜层与槽位；tierId 为 null 表示该柜层尚需新建 */
export interface SlotPlacement {
  tierId: string | null;
  tierKey: string;
  cabinetNo: string;
  tierNo: number;
  slotNo: number;
}

/**
 * 为 n 个新装具预排柜层槽位。
 * 已有柜层（含写库失败挂起的装具）占用的槽位全部保留，不得挤占；
 * 从 A-1 起顺序扫描已存在柜层，先回填空槽；已存在柜层排满后才开新层，
 * 同柜位满 TIERS_PER_CABINET 层后换下一个柜位。
 */
export function planContainerSlots(
  existingTiers: ShelfTier[],
  existingContainers: Pick<Container, 'shelfTierId' | 'slotNo'>[],
  count: number,
): SlotPlacement[] {
  const tierByKey = new Map<string, ShelfTier>();
  existingTiers.forEach((tier) => {
    tierByKey.set(tierKey(tier.cabinetNo, tier.tierNo), tier);
  });

  const occupied = new Map<string, Set<number>>();
  existingContainers.forEach((container) => {
    if (!container.shelfTierId || !container.slotNo) return;
    const tier = existingTiers.find((item) => item.id === container.shelfTierId);
    if (!tier) return;
    const key = tierKey(tier.cabinetNo, tier.tierNo);
    occupied.set(key, new Set([...(occupied.get(key) ?? []), container.slotNo]));
  });

  const placements: SlotPlacement[] = [];
  let remaining = count;
  // 从第一个柜层起顺序扫描；已存在柜层排满后自然延伸到尚未创建的 A-x / B-x
  let ordinal = 0;
  let guard = 0;
  while (remaining > 0) {
    guard += 1;
    if (guard > 100000) break;
    const cabinetNo = cabinetNoAt(Math.floor(ordinal / TIERS_PER_CABINET));
    const tierNo = (ordinal % TIERS_PER_CABINET) + 1;
    const key = tierKey(cabinetNo, tierNo);
    const taken = occupied.get(key) ?? new Set<number>();
    for (let slotNo = 1; slotNo <= TIER_SLOT_CAPACITY && remaining > 0; slotNo += 1) {
      if (taken.has(slotNo)) continue;
      const tier = tierByKey.get(key);
      placements.push({ tierId: tier?.id ?? null, tierKey: key, cabinetNo, tierNo, slotNo });
      taken.add(slotNo);
      remaining -= 1;
    }
    occupied.set(key, taken);
    ordinal += 1;
  }
  return placements;
}

export function tierKey(cabinetNo: string, tierNo: number): string {
  return tierCodeOf(cabinetNo, tierNo);
}

/** 柜层位置序号：A-1=0 …… A-5=4，B-1=5 …… */
export function tierOrdinal(cabinetNo: string, tierNo: number): number {
  const cabinetIndex = cabinetNo.toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0);
  return cabinetIndex * TIERS_PER_CABINET + (tierNo - 1);
}

/** 旧藏升级粗分档：按长边尺寸分小 / 中 / 大三档，分不上（尺寸不可解析或超上限）为 null */
export type SizeBand = 'small' | 'medium' | 'large';

/** 三档粗分边界（长边厘米） */
export const SIZE_BAND_BOUNDS: Array<{ band: SizeBand; maxEdgeCm: number }> = [
  { band: 'small', maxEdgeCm: 150 },
  { band: 'medium', maxEdgeCm: 220 },
  { band: 'large', maxEdgeCm: CONTAINER_SIZE_LIMIT_CM },
];

export const SIZE_BAND_LABEL: Record<SizeBand, string> = {
  small: '小尺寸',
  medium: '中尺寸',
  large: '大尺寸',
};

/**
 * 旧拓本升级时按尺寸先粗分：
 * - 尺寸解析不出或单件即超装具上限 → null（分不上，留待上架）；
 * - 其余按长边落 small / medium / large 档，同档顺次装箱。
 */
export function classifySizeBand(lengthCm: number | null): SizeBand | null {
  if (lengthCm === null || lengthCm <= 0 || lengthCm > CONTAINER_SIZE_LIMIT_CM) return null;
  const hit = SIZE_BAND_BOUNDS.find((item) => lengthCm <= item.maxEdgeCm);
  return hit ? hit.band : null;
}

/** 装具占用快照 → ContainerItem */
export function toContainerItem(rubbingId: string, measuredSize: string): ContainerItem {
  const parsed = parseSizeCm(measuredSize);
  return { rubbingId, sizeCm: measuredSize, lengthCm: parsed.longEdge ?? 0 };
}
