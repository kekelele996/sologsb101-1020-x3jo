/**
 * 库房写库网关
 * 库房侧把装具写库是独立动作：一个装具写库失败，只重试这一个装具，
 * 其余装具照常上架，编目台（拓本 / 拓法 / 损泐字位）一律不动。
 *
 * 纯前端没有真实库房服务，这里用可切换的故障注入模拟库房写库：
 * - failNext：下一个装具写库失败一次（用于演示自动重试这一个装具）
 * - failAlways：指定装具持续失败（用于演示装具挂起、稍后人工重试）
 */
import { db } from './db';
import type { Container, ShelfFaultMode } from '@/types/shelf';
import type { ContainerWrite, LayerWrite } from './shelfPack';

/** 库房写库失败 */
export class ShelfWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShelfWriteError';
  }
}

let faultMode: ShelfFaultMode = 'none';
let persistentFailureContainerId: string | null = null;

export function getShelfFaultMode(): ShelfFaultMode {
  return faultMode;
}

/** 切换故障注入；failAlways 时可指定持续失败的装具 id（不传则所有装具都失败） */
export function setShelfFaultMode(mode: ShelfFaultMode, containerId: string | null = null): void {
  faultMode = mode;
  persistentFailureContainerId = mode === 'failAlways' ? containerId : null;
}

export function getPersistentFailureContainerId(): string | null {
  return persistentFailureContainerId;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 模拟库房一次写库调用，按故障注入模式抛错；正常时返回写库时间戳 */
async function callWarehouseWrite(containerId: string, attempt: number): Promise<number> {
  await delay(60);
  if (faultMode === 'failAlways' && (persistentFailureContainerId === null || persistentFailureContainerId === containerId)) {
    throw new ShelfWriteError(`库房写库被拒（装具 ${containerId} 持续失败，第 ${attempt} 次）`);
  }
  if (faultMode === 'failNext') {
    // 只让下一次调用失败，随后自动恢复：体现「失败后重试这一个装具」
    faultMode = 'none';
    throw new ShelfWriteError(`库房写库超时（装具 ${containerId} 首次写入失败，第 ${attempt} 次）`);
  }
  return Date.now();
}

/** 先把本批装具引用到的新层落库（层是共享资源，不随装具失败回滚） */
export async function commitNewLayers(layerWrites: LayerWrite[]): Promise<void> {
  if (layerWrites.length === 0) return;
  const now = Date.now();
  await db.shelfLayers.bulkPut(
    layerWrites.map((layer) => ({
      id: layer.layerId,
      seq: layer.seq,
      name: layer.name,
      slotCount: layer.slotCount,
      slotsUsed: 0,
      createdAt: now,
      updatedAt: now,
    })),
  );
}

export interface ContainerCommitResult {
  containerId: string;
  ok: boolean;
  error: string;
  attempt: number;
  /** 该装具本次写入的条目数（仅成功时有意义） */
  entryCount: number;
}

/**
 * 写入单个装具（独立事务，失败只影响这一个装具）：
 * 新装修具 → 建装具并占位；追加装具 → 累加尺寸合计；
 * 条目同步挂到装具下。库房调用失败时，装具与条目标 writeFailed 等待重试。
 */
export async function commitContainerWrite(
  write: ContainerWrite,
  existingContainer: Container | undefined,
): Promise<ContainerCommitResult> {
  // attempts 记累计写库失败次数：本次调用成功就不递增
  const failedAttempts = (existingContainer?.attempts ?? 0) + 1;
  try {
    await callWarehouseWrite(write.containerId, failedAttempts);
  } catch (error) {
    const message = error instanceof Error ? error.message : '库房写库未知错误';
    const now = Date.now();
    await db.transaction('rw', [db.shelfContainers, db.shelfEntries, db.shelfLayers], async () => {
      if (existingContainer) {
        await db.shelfContainers.update(write.containerId, {
          status: 'writeFailed',
          totalSizeCm: write.totalSizeCm,
          attempts: failedAttempts,
          lastError: message,
          updatedAt: now,
        } as never);
      }
      // 新建装具写库失败也要占住柜位槽位：失败不腾位，只挂起这一个装具
      if (!existingContainer && write.kind === 'new') {
        await db.shelfContainers.put({
          id: write.containerId,
          code: write.code,
          sequenceNo: write.sequenceNo,
          bucket: write.bucket,
          sizeLimitCm: write.sizeLimitCm,
          totalSizeCm: 0,
          layerId: write.layerId,
          slotNo: write.slotNo,
          status: 'writeFailed',
          attempts: failedAttempts,
          lastError: message,
          createdAt: now,
          updatedAt: now,
        });
        // 失败装具同样占住槽位，层已在 commitNewLayers 建好
        await db.shelfLayers.update(write.layerId, { slotsUsed: write.slotNo, updatedAt: now } as never);
      }
      await db.shelfEntries.where('id').anyOf(write.addEntryIds).modify({
        containerId: write.containerId,
        status: 'writeFailed',
        attempts: failedAttempts,
        lastError: message,
        updatedAt: now,
      } as never);
    });
    return { containerId: write.containerId, ok: false, error: message, attempt: failedAttempts, entryCount: 0 };
  }

  // 库房写库成功：本地落库装具与条目（编目台表不参与事务、不动）
  const successAttempts = existingContainer?.attempts ?? 0;
  const now = Date.now();
  await db.transaction('rw', [db.shelfContainers, db.shelfEntries, db.shelfLayers], async () => {
    if (write.kind === 'new') {
      await db.shelfContainers.put({
        id: write.containerId,
        code: write.code,
        sequenceNo: write.sequenceNo,
        bucket: write.bucket,
        sizeLimitCm: write.sizeLimitCm,
        totalSizeCm: write.totalSizeCm,
        layerId: write.layerId,
        slotNo: write.slotNo,
        status: 'ready',
        attempts: successAttempts,
        lastError: '',
        createdAt: now,
        updatedAt: now,
      });
      await db.shelfLayers.update(write.layerId, { slotsUsed: write.slotNo, updatedAt: now } as never);
    } else {
      await db.shelfContainers.update(write.containerId, {
        totalSizeCm: write.totalSizeCm,
        status: 'ready',
        attempts: successAttempts,
        lastError: '',
        updatedAt: now,
      } as never);
    }
    await db.shelfEntries.where('id').anyOf(write.addEntryIds).modify({
      containerId: write.containerId,
      status: 'shelved',
      attempts: successAttempts,
      lastError: '',
      updatedAt: now,
    } as never);
  });

  return { containerId: write.containerId, ok: true, error: '', attempt: successAttempts, entryCount: write.addEntryIds.length };
}
