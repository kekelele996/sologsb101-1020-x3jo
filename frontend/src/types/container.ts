/**
 * 装具（Container）数据模型
 * 库房排架账上承装拓本的盒、匣、函套。库房按拓本实测尺寸依次装入：
 * 一个装具内拓本「长边尺寸合计」有上限，放不下的另起一个装具。
 * 写库失败的装具单独挂起，仅重试这一个装具，编目台数据不回滚。
 */

/** 装具状态：在用 / 已封箱 / 写库失败（待重试这一个装具） */
export type ContainerStatus = 'open' | 'closed' | 'writeFailed';

/** 装具内单件拓本的占用记录（尺寸以库房实测为准） */
export interface ContainerItem {
  /** 对应编目台拓本 id */
  rubbingId: string;
  /** 库房实测尺寸原文，如 210×88 */
  sizeCm: string;
  /** 计入合计的长边厘米数（由实测尺寸解析） */
  lengthCm: number;
}

export interface Container {
  id: string;
  /** 装具编号（排架人工号），如 装具-0001 */
  code: string;
  /** 所在柜层 id；写库瞬间柜层尚未建成时可能为 null */
  shelfTierId: string | null;
  /** 柜层内槽位号，从 1 起；每层能摆几个装具定死 */
  slotNo: number | null;
  /** 已装入的拓本（按入库顺序） */
  items: ContainerItem[];
  /** 已占用尺寸合计：items 长边之和（厘米） */
  usedSizeCm: number;
  status: ContainerStatus;
  /** 最近一次写库失败原因（writeFailed 时回显） */
  lastWriteError: string;
  /** 本装具累计写库尝试次数 */
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export type ContainerDraft = Omit<Container, 'id' | 'createdAt' | 'updatedAt'>;

/** 装具容量上限：可容纳拓本长边尺寸合计（厘米），馆内定死 */
export const CONTAINER_SIZE_LIMIT_CM = 600;

/** 同一装具单次写库失败后的最大尝试次数（含首次） */
export const CONTAINER_WRITE_MAX_ATTEMPTS = 3;

/** 各次重试之间的等待基数（毫秒），按尝试次数递增 */
export const CONTAINER_RETRY_BASE_DELAY_MS = 120;

export const CONTAINER_STATUS_LABEL: Record<ContainerStatus, string> = {
  open: '在用',
  closed: '已封箱',
  writeFailed: '写库失败',
};

export const CONTAINER_STATUS_COLOR: Record<ContainerStatus, string> = {
  open: '#2f6f4f',
  closed: '#8c8c8c',
  writeFailed: '#b03a2e',
};

/** 取下一个装具编号：装具-0001、装具-0002…… 失败挂起的装具也占号 */
export function nextContainerCode(existing: Pick<Container, 'code'>[]): string {
  const max = existing.reduce((acc, container) => {
    const matched = /^装具-(\d+)$/.exec(container.code.trim());
    return matched ? Math.max(acc, Number.parseInt(matched[1] as string, 10)) : acc;
  }, 0);
  return `装具-${String(max + 1).padStart(4, '0')}`;
}
