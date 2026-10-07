/**
 * 库房排架（Shelf）数据模型
 * 库房按拓本实测尺寸把拓本装进装具、摆上柜位层；编目台只登拓本、损泐与断代，
 * 排架账由库房另记一份，本模型负责两边对账：
 * - 实测尺寸以库房为准（覆盖编目员量得尺寸），拓法与损泐字位不动
 * - 账上认不出对应拓本的收藏号，先挂「待认领」等人来认
 * - 旧拓本没有装具号，升级时按尺寸先粗分，分不上的留待上架
 */

/** 尺寸粗分桶：大 / 中 / 小（按拓本高度厘米） */
export type ShelfSizeBucket = 'large' | 'medium' | 'small';

/**
 * 排架账条目状态：
 * - pending 已粗分、待装入装具（排队上架）
 * - shelved 已装入装具、已摆上柜位层
 * - pendingClaim 收藏号认不出对应拓本，等人认领
 * - pendingShelf 尺寸分不上（过大 / 不可辨），留待上架
 * - writeFailed 所属装具写库失败，随该装具等待重试
 */
export type ShelfEntryStatus = 'pending' | 'shelved' | 'pendingClaim' | 'pendingShelf' | 'writeFailed';

/** 装具状态：就绪 / 写库失败（库房侧写库失败只挂起这一个装具） */
export type ContainerStatus = 'ready' | 'writeFailed';

export interface ShelfLayer {
  id: string;
  /** 层序，从 1 开始，按装具摆满一层自动递增 */
  seq: number;
  /** 层名，如「第 1 层」 */
  name: string;
  /** 该层定死能摆的装具数 */
  slotCount: number;
  /** 已占用槽位（含写库失败装具，失败也占位、不腾位） */
  slotsUsed: number;
  createdAt: number;
  updatedAt: number;
}

export interface Container {
  id: string;
  /** 装具号，如「装具-001」 */
  code: string;
  /** 装具序号，与 code 对应，装具放不下另起一个时递增 */
  sequenceNo: number;
  /** 装具按粗分桶配尺寸上限 */
  bucket: ShelfSizeBucket;
  /** 一个装具装得下的尺寸合计上限（厘米，按拓本高度合计） */
  sizeLimitCm: number;
  /** 已装入的尺寸合计 */
  totalSizeCm: number;
  /** 所在柜位层 id */
  layerId: string;
  /** 层内槽位号，从 1 开始 */
  slotNo: number;
  status: ContainerStatus;
  /** 库房写库尝试次数 */
  attempts: number;
  /** 最近一次写库错误说明 */
  lastError: string;
  createdAt: number;
  updatedAt: number;
}

export interface ShelfEntry {
  id: string;
  /** 排架账上的收藏号（库房照抄，可能认不出对应拓本） */
  collectionNo: string;
  /** 认出的对应拓本 id；认不出时为 null，挂待认领 */
  rubbingId: string | null;
  /** 库房实测尺寸（厘米原文，如 212×88），对账时以此为准 */
  measuredSizeCm: string;
  /** 对账时编目员量得尺寸的留底，仅备查，不回写编目台 */
  catalogSizeCmSnapshot: string;
  /** 尺寸粗分桶；分不上时为 null */
  bucket: ShelfSizeBucket | null;
  /** 已装入的装具 id；未上架为 null */
  containerId: string | null;
  status: ShelfEntryStatus;
  /** 随装具写库的尝试次数 */
  attempts: number;
  /** 最近一次写库错误说明 */
  lastError: string;
  /** 备注（如升级粗分、留待上架原因） */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export interface ShelfConfig {
  /** 每层定死的装具数 */
  slotsPerLayer: number;
  /** 各粗分桶装具的尺寸合计上限（厘米） */
  limits: Record<ShelfSizeBucket, number>;
}

export const SHELF_BUCKET_LABEL: Record<ShelfSizeBucket, string> = {
  large: '大件',
  medium: '中件',
  small: '小件',
};

export const SHELF_BUCKET_COLOR: Record<ShelfSizeBucket, string> = {
  large: '#7a4a3a',
  medium: '#3f5d6b',
  small: '#2f6f4f',
};

/** 装箱时按桶的处理顺序：先大件后小件 */
export const SHELF_BUCKET_ORDER: readonly ShelfSizeBucket[] = ['large', 'medium', 'small'];

export const SHELF_ENTRY_STATUS_LABEL: Record<ShelfEntryStatus, string> = {
  pending: '待装具',
  shelved: '已上架',
  pendingClaim: '待认领',
  pendingShelf: '留待上架',
  writeFailed: '写库失败',
};

export const SHELF_ENTRY_STATUS_COLOR: Record<ShelfEntryStatus, string> = {
  pending: '#c9963c',
  shelved: '#2f6f4f',
  pendingClaim: '#a33a2c',
  pendingShelf: '#8c8c8c',
  writeFailed: '#b03a2e',
};

export const CONTAINER_STATUS_LABEL: Record<ContainerStatus, string> = {
  ready: '在架',
  writeFailed: '写库失败',
};

export const CONTAINER_STATUS_COLOR: Record<ContainerStatus, string> = {
  ready: '#2f6f4f',
  writeFailed: '#b03a2e',
};

/** 粗分阈值（拓本高度厘米）：≥240 大件，180–239 中件，<180 小件 */
export const SHELF_BUCKET_MIN_HEIGHT: Record<ShelfSizeBucket, number> = {
  large: 240,
  medium: 180,
  small: 0,
};

/** 装具尺寸合计上限默认值（厘米） */
export const DEFAULT_SHELF_LIMITS: Record<ShelfSizeBucket, number> = {
  large: 960,
  medium: 720,
  small: 520,
};

/** 柜位一层默认摆几个装具（定死） */
export const DEFAULT_SLOTS_PER_LAYER = 4;

export const DEFAULT_SHELF_CONFIG: ShelfConfig = {
  slotsPerLayer: DEFAULT_SLOTS_PER_LAYER,
  limits: { ...DEFAULT_SHELF_LIMITS },
};

/** 库房写库故障模拟模式：正常 / 下一个装具失败一次（验自动重试）/ 持续失败（验挂起重试） */
export type ShelfFaultMode = 'none' | 'failNext' | 'failAlways';

export const SHELF_FAULT_LABEL: Record<ShelfFaultMode, string> = {
  none: '写库正常',
  failNext: '下一装具失败一次',
  failAlways: '装具持续写库失败',
};

/** 从排架账文本解析一行：收藏号,实测尺寸 */
export interface ShelfLedgerRow {
  collectionNo: string;
  measuredSizeCm: string;
}

export function createEmptyShelfEntryDraft(): Omit<ShelfEntry, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    collectionNo: '',
    rubbingId: null,
    measuredSizeCm: '',
    catalogSizeCmSnapshot: '',
    bucket: null,
    containerId: null,
    status: 'pendingClaim',
    attempts: 0,
    lastError: '',
    note: '',
  };
}
