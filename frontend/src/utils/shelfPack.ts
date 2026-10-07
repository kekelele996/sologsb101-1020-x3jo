/**
 * 排架装箱规则（纯函数，便于核对）
 * - 库房按拓本尺寸往装具里放：一个装具装得下的尺寸合计有上限，放不下的另起一个
 * - 柜位一层能摆几个装具定死：摆满一层自动开下一层
 * - 旧拓本升级时按尺寸先粗分（大件 / 中件 / 小件），分不上的留待上架
 */
import {
  DEFAULT_SHELF_CONFIG,
  SHELF_BUCKET_MIN_HEIGHT,
  SHELF_BUCKET_ORDER,
  type ShelfConfig,
  type ShelfEntry,
  type ShelfSizeBucket,
} from '@/types/shelf';

/** 「210×88」「210 x 88」「210*88 厘米」等写法解析为高 × 宽（厘米）；不可辨返回 null */
export function parseSizeCm(text: string): { height: number; width: number } | null {
  if (!text) return null;
  const matched = /(\d+(?:\.\d+)?)\s*[×xX*＊]\s*(\d+(?:\.\d+)?)/.exec(text);
  if (!matched) return null;
  const a = Number.parseFloat(matched[1] as string);
  const b = Number.parseFloat(matched[2] as string);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  // 高 ≥ 宽，统一口径，粗分只看高度
  return { height: Math.max(a, b), width: Math.min(a, b) };
}

/** 按高度粗分：≥240 大件，≥180 中件，其余小件；尺寸不可辨返回 null */
export function bucketOfSize(text: string): ShelfSizeBucket | null {
  const size = parseSizeCm(text);
  if (!size) return null;
  if (size.height >= SHELF_BUCKET_MIN_HEIGHT.large) return 'large';
  if (size.height >= SHELF_BUCKET_MIN_HEIGHT.medium) return 'medium';
  return 'small';
}

/** 条目参与尺寸合计的高度（待认领 / 留待上架也按实测尺寸算）；不可辨返回 0 */
export function entryHeightCm(entry: Pick<ShelfEntry, 'measuredSizeCm'>): number {
  return parseSizeCm(entry.measuredSizeCm)?.height ?? 0;
}

/* ------------------------------ 装箱计划 ------------------------------ */

export type ContainerWrite =
  | { kind: 'existing'; containerId: string; addEntryIds: string[]; totalSizeCm: number }
  | {
      kind: 'new';
      containerId: string;
      code: string;
      sequenceNo: number;
      bucket: ShelfSizeBucket;
      sizeLimitCm: number;
      layerId: string;
      layerSeq: number;
      slotNo: number;
      addEntryIds: string[];
      totalSizeCm: number;
    };

export type LayerWrite = { layerId: string; seq: number; name: string; slotCount: number; slotsUsed: number };

export interface PackingPlan {
  /** 需要新建的层（含 seq / 槽位） */
  newLayers: LayerWrite[];
  /** 每个要写库的装具一份写入指令（失败时按装具逐条重试） */
  containerWrites: ContainerWrite[];
  /** 本次被装入装具的条目 → 装具、状态 */
  entryWrites: Array<{ entryId: string; containerId: string; status: ShelfEntry['status'] }>;
  /** 尺寸分不上 / 单件超装具上限的条目：留待上架 */
  unshelvedEntryIds: string[];
  /** 下一个装具序号 */
  nextSequenceNo: number;
}

interface WorkingContainer {
  id: string;
  sequenceNo: number;
  bucket: ShelfSizeBucket;
  totalSizeCm: number;
  layerId: string;
  slotNo: number;
  /** 已就绪装具：只追加条目，不重建 */
  existing: boolean;
  addEntryIds: string[];
}

interface WorkingLayer {
  id: string;
  seq: number;
  slotsUsed: number;
}

export interface PackingInput {
  entries: ShelfEntry[];
  containers: Array<{
    id: string;
    sequenceNo: number;
    bucket: ShelfSizeBucket;
    totalSizeCm: number;
    layerId: string;
    slotNo: number;
    status: 'ready' | 'writeFailed';
  }>;
  layers: Array<{ id: string; seq: number; slotCount: number; slotsUsed: number }>;
  config: ShelfConfig;
  /** 临时 id 前缀（迁移 / 播种走确定性 id，日常装箱传时间戳） */
  idBase?: string | number;
}

function containerCode(sequenceNo: number): string {
  return `装具-${String(sequenceNo).padStart(3, '0')}`;
}

/**
 * 按「尺寸合计不超上限、放不下另起一个、每层装具数定死」生成装箱计划。
 * 只动 status 为 pending 的条目；写库失败装具不参与，其条目随该装具单独重试。
 */
export function planPacking(input: PackingInput): PackingPlan {
  const { config } = input;
  const base = input.idBase ?? Date.now();
  const containerWrites: ContainerWrite[] = [];
  const entryWrites: PackingPlan['entryWrites'] = [];
  const newLayers: LayerWrite[] = [];

  const workLayers = new Map<string, WorkingLayer>();
  input.layers.forEach((layer) => {
    workLayers.set(layer.id, { id: layer.id, seq: layer.seq, slotsUsed: layer.slotsUsed });
  });

  // 各桶装具的工作副本（写失败装具被排除：失败不腾位也不接收新条目）
  const workContainersByBucket = new Map<ShelfSizeBucket, WorkingContainer[]>();
  input.containers
    .filter((container) => container.status === 'ready')
    .forEach((container) => {
      const work: WorkingContainer = {
        id: container.id,
        sequenceNo: container.sequenceNo,
        bucket: container.bucket,
        totalSizeCm: container.totalSizeCm,
        layerId: container.layerId,
        slotNo: container.slotNo,
        existing: true,
        addEntryIds: [],
      };
      workContainersByBucket.set(container.bucket, [...(workContainersByBucket.get(container.bucket) ?? []), work]);
    });

  let nextSequenceNo = input.containers.reduce((max, item) => Math.max(max, item.sequenceNo), 0);
  let nextLayerSeq = input.layers.reduce((max, item) => Math.max(max, item.seq), 0);

  /** 在当前最后一个有空槽的层申请槽位；全满才开下一层（写失败装具也占槽） */
  const occupySlot = (): { layer: WorkingLayer; slotNo: number } => {
    const withRoom = Array.from(workLayers.values())
      .sort((a, b) => b.seq - a.seq)
      .find((layer) => layer.slotsUsed < config.slotsPerLayer);
    const layer = withRoom ?? (() => {
      nextLayerSeq += 1;
      const id = `slayer_${base}_${nextLayerSeq}`;
      const created: WorkingLayer = { id, seq: nextLayerSeq, slotsUsed: 0 };
      workLayers.set(id, created);
      newLayers.push({
        layerId: id,
        seq: nextLayerSeq,
        name: `第 ${nextLayerSeq} 层`,
        slotCount: config.slotsPerLayer,
        slotsUsed: 0,
      });
      return created;
    })();
    layer.slotsUsed += 1;
    return { layer, slotNo: layer.slotsUsed };
  };

  /** 开一个新装具：在当前有空槽的层占下一个槽位，全满才开新层 */
  const openContainer = (bucket: ShelfSizeBucket): WorkingContainer => {
    nextSequenceNo += 1;
    const { layer, slotNo } = occupySlot();
    const work: WorkingContainer = {
      id: `sctr_${base}_${nextSequenceNo}`,
      sequenceNo: nextSequenceNo,
      bucket,
      totalSizeCm: 0,
      layerId: layer.id,
      slotNo,
      existing: false,
      addEntryIds: [],
    };
    workContainersByBucket.set(bucket, [...(workContainersByBucket.get(bucket) ?? []), work]);
    return work;
  };

  const fitInto = (bucket: ShelfSizeBucket, height: number): WorkingContainer => {
    // 库房顺着装具号装：只往该桶当前最后一个（未写库失败的）装具里放，
    // 装得下就放，放不下另起一个，不回头翻已封的装具。
    const list = workContainersByBucket.get(bucket) ?? [];
    const current = list.length > 0 ? list[list.length - 1] : undefined;
    if (current && current.totalSizeCm + height <= config.limits[bucket]) return current;
    return openContainer(bucket);
  };

  // 只排 status=pending 的条目：先粗分，单件超装具上限 / 尺寸不可辨的留待上架
  const queue = input.entries
    .filter((entry) => entry.status === 'pending')
    .map((entry) => ({ entry, bucket: entry.bucket ?? bucketOfSize(entry.measuredSizeCm) }))
    .filter((item): item is { entry: ShelfEntry; bucket: ShelfSizeBucket } => {
      if (!item.bucket) return false;
      const height = entryHeightCm(item.entry);
      return height > 0 && height <= config.limits[item.bucket];
    })
    .sort((a, b) => a.entry.createdAt - b.entry.createdAt);

  const scheduledEntryIds = new Set<string>();
  SHELF_BUCKET_ORDER.forEach((bucket) => {
    queue
      .filter((item) => item.bucket === bucket)
      .forEach(({ entry }) => {
        const work = fitInto(bucket, entryHeightCm(entry));
        work.totalSizeCm += entryHeightCm(entry);
        work.addEntryIds.push(entry.id);
        entryWrites.push({ entryId: entry.id, containerId: work.id, status: 'shelved' });
        scheduledEntryIds.add(entry.id);
      });
  });

  // 每个被改动的装具汇总为一条写库指令（一个装具写库失败就只重试这一条）
  SHELF_BUCKET_ORDER.forEach((bucket) => {
    (workContainersByBucket.get(bucket) ?? [])
      .filter((work) => work.addEntryIds.length > 0)
      .forEach((work) => {
        if (work.existing) {
          containerWrites.push({
            kind: 'existing',
            containerId: work.id,
            addEntryIds: work.addEntryIds,
            totalSizeCm: work.totalSizeCm,
          });
        } else {
          containerWrites.push({
            kind: 'new',
            containerId: work.id,
            code: containerCode(work.sequenceNo),
            sequenceNo: work.sequenceNo,
            bucket,
            sizeLimitCm: config.limits[bucket],
            layerId: work.layerId,
            layerSeq: (workLayers.get(work.layerId) as WorkingLayer).seq,
            slotNo: work.slotNo,
            addEntryIds: work.addEntryIds,
            totalSizeCm: work.totalSizeCm,
          });
        }
      });
  });

  const unshelvedEntryIds = input.entries
    .filter((entry) => entry.status === 'pending' && !scheduledEntryIds.has(entry.id))
    .map((entry) => entry.id);

  // 新建层的 slotsUsed 在创建时为 0，装箱完成后回写最终占位数
  newLayers.forEach((layerWrite) => {
    layerWrite.slotsUsed = (workLayers.get(layerWrite.layerId) as WorkingLayer).slotsUsed;
  });

  return { newLayers, containerWrites, entryWrites, unshelvedEntryIds, nextSequenceNo };
}

export { DEFAULT_SHELF_CONFIG };
