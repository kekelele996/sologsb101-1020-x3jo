/**
 * 库房排架 slice（Redux Toolkit）
 * 维护柜位层、装具与排架账条目，以及装箱上限配置。
 * 边界约定：
 * - 库房实测尺寸与编目员量得不一致时，只覆盖拓本尺寸；拓法与损泐字位照旧不动
 * - 账上认不出对应拓本的收藏号 → pendingClaim，单独挂着等人认领
 * - 库房写库失败只重试对应装具，编目台数据不参与、不回滚
 */
import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { createId, db } from '@/utils/db';
import {
  DEFAULT_SHELF_CONFIG,
  type Container,
  type ShelfConfig,
  type ShelfEntry,
  type ShelfLayer,
  type ShelfSizeBucket,
} from '@/types/shelf';
import { bucketOfSize, entryHeightCm, planPacking, type ContainerWrite } from '@/utils/shelfPack';
import { commitContainerWrite, commitNewLayers } from '@/utils/shelfGateway';
import type { Rubbing } from '@/types/rubbing';
import { loadRubbings } from './rubbingSlice';
import type { RootState } from './store';

/** 排架定数（每层装具数 / 各桶上限）属于库房制度，localStorage 留一份跨刷新保留 */
const SHELF_CONFIG_KEY = 'gbrubbing:shelf-config';

function readPersistedConfig(): ShelfConfig {
  try {
    const raw = localStorage.getItem(SHELF_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_SHELF_CONFIG, limits: { ...DEFAULT_SHELF_CONFIG.limits } };
    const parsed = JSON.parse(raw) as Partial<ShelfConfig>;
    const slots = Number(parsed.slotsPerLayer);
    return {
      slotsPerLayer: Number.isFinite(slots) && slots >= 1 ? Math.trunc(slots) : DEFAULT_SHELF_CONFIG.slotsPerLayer,
      limits: {
        large: Number(parsed.limits?.large) || DEFAULT_SHELF_CONFIG.limits.large,
        medium: Number(parsed.limits?.medium) || DEFAULT_SHELF_CONFIG.limits.medium,
        small: Number(parsed.limits?.small) || DEFAULT_SHELF_CONFIG.limits.small,
      },
    };
  } catch {
    return { ...DEFAULT_SHELF_CONFIG, limits: { ...DEFAULT_SHELF_CONFIG.limits } };
  }
}

function persistConfig(config: ShelfConfig): void {
  try {
    localStorage.setItem(SHELF_CONFIG_KEY, JSON.stringify(config));
  } catch {
    /* ignore */
  }
}

export interface ShelfState {
  layers: ShelfLayer[];
  containers: Container[];
  entries: ShelfEntry[];
  config: ShelfConfig;
  loading: boolean;
  ready: boolean;
  error: string;
}

const initialState: ShelfState = {
  layers: [],
  containers: [],
  entries: [],
  config: readPersistedConfig(),
  loading: false,
  ready: false,
  error: '',
};

export const loadShelf = createAsyncThunk('shelf/load', async (_: undefined, { getState }) => {
  const [layers, containers, entries] = await Promise.all([
    db.shelfLayers.toArray(),
    db.shelfContainers.toArray(),
    db.shelfEntries.toArray(),
  ]);
  layers.sort((a, b) => a.seq - b.seq);
  containers.sort((a, b) => a.sequenceNo - b.sequenceNo);
  entries.sort((a, b) => (a.status === b.status ? a.createdAt - b.createdAt : a.status.localeCompare(b.status)));
  const root = getState() as RootState;
  return { layers, containers, entries, config: root.shelf.config };
});

export const saveShelfConfig = createAsyncThunk('shelf/saveConfig', async (config: ShelfConfig) => {
  persistConfig(config);
  return config;
});

export interface ReconcileRow {
  collectionNo: string;
  measuredSizeCm: string;
}

export interface ReconcileResult {
  matched: number;
  claimed: number;
  sizeOverwritten: number;
  unknown: number;
}

/**
 * 库房排架账对账：
 * - 认出拓本（按收藏号）：库房实测尺寸覆盖编目员量得尺寸；拓法、损泐字位不动
 * - 认不出：单独挂 pendingClaim 等人认领
 */
export const reconcileLedger = createAsyncThunk(
  'shelf/reconcile',
  async (rows: ReconcileRow[], { dispatch, getState }) => {
    const state = getState() as RootState;
    const rubbings = state.rubbing.items;
    const entries = state.shelf.entries;
    const now = Date.now();
    const result: ReconcileResult = { matched: 0, claimed: 0, sizeOverwritten: 0, unknown: 0 };

    // 同一收藏号可能重复登账：排架条目按收藏号聚合，已上架的先到先得
    const rubbingByNo = new Map<string, Rubbing>();
    rubbings.forEach((rubbing) => {
      const no = rubbing.collectionNo.trim();
      if (no && !rubbingByNo.has(no)) rubbingByNo.set(no, rubbing);
    });

    const entryByNo = new Map<string, ShelfEntry[]>();
    entries.forEach((entry) => {
      const no = entry.collectionNo.trim();
      if (no) entryByNo.set(no, [...(entryByNo.get(no) ?? []), entry]);
    });

    const rubbingPatches = new Map<string, string>();
    const entryPuts: ShelfEntry[] = [];
    // 同批对账可能有重复收藏号：已取用的条目不再重复匹配
    const usedEntryIds = new Set<string>();

    rows.forEach((row, index) => {
      const collectionNo = row.collectionNo.trim();
      const measuredSizeCm = row.measuredSizeCm.trim();
      if (!collectionNo) return;
      const rubbing = rubbingByNo.get(collectionNo);
      const sameNoEntries = (entryByNo.get(collectionNo) ?? []).filter((item) => !usedEntryIds.has(item.id));
      // 先认挂在同一拓本上的条目，再认挂着待认领的条目；都没有才算新登账
      const entry =
        sameNoEntries.find((item) => item.rubbingId === rubbing?.id) ??
        sameNoEntries.find((item) => !item.rubbingId) ??
        sameNoEntries[0];
      if (entry) usedEntryIds.add(entry.id);
      const bucket = bucketOfSize(measuredSizeCm);

      if (entry) {
        if (rubbing) {
          if (!entry.rubbingId) result.claimed += 1;
          const overwrites = measuredSizeCm.length > 0 && rubbing.sizeCm.trim() !== measuredSizeCm;
          if (overwrites) result.sizeOverwritten += 1;
          // 实物已在就绪装具里：保持在架；写库失败装具里：保持 writeFailed；其余按粗分入队或留待上架
          const container = entry.containerId
            ? state.shelf.containers.find((item) => item.id === entry.containerId)
            : undefined;
          const nextStatus: ShelfEntry['status'] =
            container?.status === 'ready'
              ? 'shelved'
              : entry.status === 'writeFailed'
                ? 'writeFailed'
                : bucket === null
                  ? 'pendingShelf'
                  : 'pending';
          entryPuts.push({
            ...entry,
            rubbingId: rubbing.id,
            measuredSizeCm: measuredSizeCm || entry.measuredSizeCm,
            catalogSizeCmSnapshot: rubbing.sizeCm,
            bucket: bucket ?? entry.bucket,
            status: nextStatus,
            note:
              container?.status === 'ready' || entry.status === 'writeFailed'
                ? entry.note
                : bucket === null
                  ? '库房实测尺寸分不上，留待上架'
                  : '排架账对账完成，待装入装具',
            updatedAt: now + index,
          });
          // 只在库房给了实测尺寸时才以库房为准；空着的行不覆盖编目台尺寸
          if (measuredSizeCm.length > 0) rubbingPatches.set(rubbing.id, measuredSizeCm);
          result.matched += 1;
        } else {
          // 排架条目挂着，但编目台确实没这号：继续待认领
          entryPuts.push({
            ...entry,
            measuredSizeCm: measuredSizeCm || entry.measuredSizeCm,
            bucket: bucket ?? entry.bucket,
            status: entry.status === 'shelved' ? entry.status : 'pendingClaim',
            updatedAt: now + index,
          });
          result.unknown += 1;
        }
      } else if (rubbing) {
        // 新对上的账：建条目并以库房尺寸为准
        const overwrites = measuredSizeCm.length > 0 && rubbing.sizeCm.trim() !== measuredSizeCm;
        if (overwrites) result.sizeOverwritten += 1;
        entryPuts.push({
          id: createId('shent'),
          collectionNo,
          rubbingId: rubbing.id,
          measuredSizeCm,
          catalogSizeCmSnapshot: rubbing.sizeCm,
          bucket,
          containerId: null,
          status: bucket === null ? 'pendingShelf' : 'pending',
          attempts: 0,
          lastError: '',
          note: bucket === null ? '库房实测尺寸分不上，留待上架' : '排架账新登，待装入装具',
          createdAt: now + index,
          updatedAt: now + index,
        });
        if (measuredSizeCm.length > 0) rubbingPatches.set(rubbing.id, measuredSizeCm);
        result.matched += 1;
      } else {
        // 认不出对应拓本：先单独记着等人认领
        entryPuts.push({
          id: createId('shent'),
          collectionNo,
          rubbingId: null,
          measuredSizeCm,
          catalogSizeCmSnapshot: '',
          bucket,
          containerId: null,
          status: 'pendingClaim',
          attempts: 0,
          lastError: '',
          note: '排架账上认不出对应拓本，等人认领',
          createdAt: now + index,
          updatedAt: now + index,
        });
        result.unknown += 1;
      }
    });

    await db.shelfEntries.bulkPut(entryPuts);
    // 只覆盖尺寸一个字段：拓法、纸墨、损泐字位、断代结论照旧不动
    await Promise.all(
      Array.from(rubbingPatches.entries()).map(([id, sizeCm]) =>
        db.rubbings.update(id, { sizeCm, updatedAt: now } as never),
      ),
    );
    await dispatch(loadShelf());
    await dispatch(loadRubbings());
    return result;
  },
);

export interface ShelvingSummary {
  newLayers: number;
  writes: Array<{ containerId: string; ok: boolean; error: string; entryCount: number }>;
  shelved: number;
  failed: number;
  held: number;
}

/** 把待装具条目按尺寸合计上限装箱、摆层；一个装具写库失败只挂起并（故障恢复后可）重试这一个 */
export const packPending = createAsyncThunk('shelf/pack', async (_: undefined, { dispatch, getState }) => {
  const state = getState() as RootState;
  const { entries, containers, layers, config } = state.shelf;
  const plan = planPacking({ entries, containers, layers, config });

  // 尺寸分不上 / 单件超上限：留待上架
  if (plan.unshelvedEntryIds.length > 0) {
    const now = Date.now();
    await db.shelfEntries.where('id').anyOf(plan.unshelvedEntryIds).modify({
      bucket: null,
      status: 'pendingShelf',
      note: '尺寸分不上装具，留待上架',
      updatedAt: now,
    } as never);
  }

  await commitNewLayers(plan.newLayers);

  const writes: ShelvingSummary['writes'] = [];
  let failedNow = 0;
  for (const write of plan.containerWrites) {
    // 逐装具独立写库：前一个失败不影响后续装具
    const existing = write.kind === 'existing' ? containers.find((item) => item.id === write.containerId) : undefined;
    let outcome = await commitContainerWrite(write, existing);
    // 库房写库失败后就重试这一个装具（一次）；仍失败则挂起，留给人工重试
    if (!outcome.ok) {
      failedNow += 1;
      const failedRow = await db.shelfContainers.get(write.containerId);
      const retried = await commitContainerWrite(write, failedRow);
      if (retried.ok) failedNow -= 1;
      outcome = retried;
    }
    writes.push({ containerId: outcome.containerId, ok: outcome.ok, error: outcome.error, entryCount: outcome.entryCount });
  }

  await dispatch(loadShelf());
  return {
    newLayers: plan.newLayers.length,
    writes,
    shelved: writes.filter((item) => item.ok).reduce((sum, item) => sum + item.entryCount, 0),
    failed: failedNow,
    held: plan.unshelvedEntryIds.length,
  } satisfies ShelvingSummary;
});

/** 重试写库失败的装具：只重写这一个装具及其条目，编目台不动 */
export const retryContainer = createAsyncThunk('shelf/retryContainer', async (containerId: string, { dispatch, getState }) => {
  const state = getState() as RootState;
  const container = state.shelf.containers.find((item) => item.id === containerId);
  if (!container || container.status !== 'writeFailed') return null;
  // 追加写入的旧装具失败时，原有条目仍在架（shelved），尺寸合计要把它们一并算回
  const memberIds = state.shelf.entries
    .filter((entry) => entry.containerId === containerId && entry.status === 'writeFailed')
    .map((entry) => entry.id);
  if (memberIds.length === 0) return null;

  // 用该装具当前条目重建这一个装具的写入指令（尺寸合计按库房实测重新累加）
  const totalSizeCm = state.shelf.entries
    .filter((entry) => entry.containerId === containerId)
    .reduce((sum, entry) => sum + entryHeightCm(entry), 0);

  // 写库失败时新装修具已占位落库，重试一律走 existing 更新
  const write: ContainerWrite = { kind: 'existing', containerId, addEntryIds: memberIds, totalSizeCm };
  const outcome = await commitContainerWrite(write, container);
  await dispatch(loadShelf());
  return outcome;
});

/** 待认领条目认领到拓本：认到后按库房实测尺寸粗分并入待装具队列 */
export const claimEntry = createAsyncThunk(
  'shelf/claim',
  async (payload: { entryId: string; rubbingId: string }, { dispatch, getState }) => {
    const state = getState() as RootState;
    const entry = state.shelf.entries.find((item) => item.id === payload.entryId);
    const rubbing = state.rubbing.items.find((item) => item.id === payload.rubbingId);
    if (!entry || !rubbing) return false;
    const measuredSizeCm = entry.measuredSizeCm || rubbing.sizeCm;
    const bucket = bucketOfSize(measuredSizeCm);
    const now = Date.now();
    // 条目可能本来就实物在架（如拓本删除后解绑）：就绪装具保持在架，写失败装具保持 writeFailed
    const container = entry.containerId
      ? state.shelf.containers.find((item) => item.id === entry.containerId)
      : undefined;
    const nextStatus: ShelfEntry['status'] =
      container?.status === 'ready'
        ? 'shelved'
        : entry.status === 'writeFailed'
          ? 'writeFailed'
          : bucket === null
            ? 'pendingShelf'
            : 'pending';
    await db.transaction('rw', [db.shelfEntries, db.rubbings], async () => {
      await db.shelfEntries.put({
        ...entry,
        rubbingId: rubbing.id,
        measuredSizeCm,
        catalogSizeCmSnapshot: rubbing.sizeCm,
        bucket,
        status: nextStatus,
        note:
          container?.status === 'ready' || entry.status === 'writeFailed'
            ? '已认领，实物保持原装具'
            : bucket === null
              ? '已认领，尺寸分不上留待上架'
              : '已认领，待装入装具',
        updatedAt: now,
      });
      // 认领同样以库房实测尺寸为准（只改尺寸，拓法 / 损泐不动）
      if (measuredSizeCm && measuredSizeCm !== rubbing.sizeCm) {
        await db.rubbings.update(rubbing.id, { sizeCm: measuredSizeCm, updatedAt: now } as never);
      }
    });
    await dispatch(loadShelf());
    await dispatch(loadRubbings());
    return true;
  },
);

/** 留待上架条目补测尺寸后重新粗分（尺寸可辨则回到待装具队列） */
export const remeasureEntry = createAsyncThunk(
  'shelf/remeasure',
  async (payload: { entryId: string; measuredSizeCm: string; note?: string }, { dispatch, getState }) => {
    const state = getState() as RootState;
    const entry = state.shelf.entries.find((item) => item.id === payload.entryId);
    if (!entry) return false;
    const bucket = bucketOfSize(payload.measuredSizeCm);
    const now = Date.now();
    // 写库失败装具里的条目：补测只改尺寸与粗分，仍随原装具等待重试，不退回到待装具队列
    const staysWithFailed = entry.status === 'writeFailed' && entry.containerId !== null;
    await db.shelfEntries.put({
      ...entry,
      measuredSizeCm: payload.measuredSizeCm,
      bucket: staysWithFailed ? bucket ?? entry.bucket : bucket,
      containerId: staysWithFailed ? entry.containerId : null,
      status: staysWithFailed ? 'writeFailed' : bucket === null ? 'pendingShelf' : 'pending',
      note:
        payload.note ??
        (staysWithFailed
          ? '已补测尺寸，随原装具等待重试'
          : bucket === null
            ? '尺寸仍分不上，留待上架'
            : '补测完成，待装入装具'),
      lastError: staysWithFailed ? entry.lastError : '',
      updatedAt: now,
    });
    await dispatch(loadShelf());
    return true;
  },
);

/** 删除排架账条目（库房销账；编目台拓本不动） */
export const removeShelfEntry = createAsyncThunk('shelf/removeEntry', async (id: string, { dispatch }) => {
  await db.shelfEntries.delete(id);
  await dispatch(loadShelf());
});

const shelfSlice = createSlice({
  name: 'shelf',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(loadShelf.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadShelf.fulfilled, (state, action) => {
        state.layers = action.payload.layers;
        state.containers = action.payload.containers;
        state.entries = action.payload.entries;
        state.config = action.payload.config;
        state.loading = false;
        state.ready = true;
        state.error = '';
      })
      .addCase(loadShelf.rejected, (state, action) => {
        state.loading = false;
        state.ready = true;
        state.error = action.error.message ?? '排架账读取失败';
      })
      .addCase(saveShelfConfig.fulfilled, (state, action) => {
        state.config = action.payload;
      });
  },
});

export const selectShelfState = (state: RootState): ShelfState => state.shelf;
export const selectShelfLayers = (state: RootState): ShelfLayer[] => state.shelf.layers;
export const selectShelfContainers = (state: RootState): Container[] => state.shelf.containers;
export const selectShelfEntries = (state: RootState): ShelfEntry[] => state.shelf.entries;

/** 柜位层 → 装具 → 条目的派生结构，供排架台逐层展示 */
export interface ShelfLayerView {
  layer: ShelfLayer;
  containers: Array<{ container: Container; entries: ShelfEntry[] }>;
}

export function selectShelfLayout(state: RootState): ShelfLayerView[] {
  return state.shelf.layers
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((layer) => ({
      layer,
      containers: state.shelf.containers
        .filter((container) => container.layerId === layer.id)
        .sort((a, b) => a.slotNo - b.slotNo)
        .map((container) => ({
          container,
          entries: state.shelf.entries
            .filter((entry) => entry.containerId === container.id)
            .sort((a, b) => a.createdAt - b.createdAt),
        })),
    }));
}

/** 各状态条目计数 */
export function selectShelfCounters(state: RootState): Record<ShelfEntry['status'], number> {
  const counters: Record<ShelfEntry['status'], number> = {
    pending: 0,
    shelved: 0,
    pendingClaim: 0,
    pendingShelf: 0,
    writeFailed: 0,
  };
  state.shelf.entries.forEach((entry) => {
    counters[entry.status] += 1;
  });
  return counters;
}

/** 拓本 id → 排架条目（拓本登记页显示库房装具号用） */
export function selectShelfEntryByRubbing(state: RootState): Map<string, ShelfEntry> {
  const map = new Map<string, ShelfEntry>();
  state.shelf.entries.forEach((entry) => {
    if (entry.rubbingId) map.set(entry.rubbingId, entry);
  });
  return map;
}

export function selectBucketLabel(bucket: ShelfSizeBucket | null): string {
  return bucket ? { large: '大件', medium: '中件', small: '小件' }[bucket] : '未分';
}

export default shelfSlice.reducer;
