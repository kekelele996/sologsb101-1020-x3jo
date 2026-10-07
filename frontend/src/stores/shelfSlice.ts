/**
 * 排架 slice（Redux Toolkit）
 * 维护库房排架账三表：柜层、装具、入库流水。
 * 入库 / 认领 / 补量上架 / 失败装具重试的编排都在 utils/db.ts，
 * slice 仅负责 thunk 派发与集合刷新；编目台拓本尺寸由 db 层以库房实测回写，
 * 完成后顺带刷新 rubbingSlice。
 */
import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import {
  claimShelfIntake,
  createSimulatedContainerWriter,
  db,
  processShelfIntake,
  removeShelfIntake,
  retryFailedContainer,
  shelvePendingIntake,
  type ContainerWriter,
} from '@/utils/db';
import type { Container } from '@/types/container';
import { describeShelfTier, type ShelfTier } from '@/types/shelfTier';
import type { ShelfIntake } from '@/types/shelfIntake';
import type { RootState } from './store';
import { loadRubbings } from './rubbingSlice';

export interface ShelvingState {
  tiers: ShelfTier[];
  containers: Container[];
  intakes: ShelfIntake[];
  loading: boolean;
  ready: boolean;
  error: string;
}

const initialState: ShelvingState = {
  tiers: [],
  containers: [],
  intakes: [],
  loading: false,
  ready: false,
  error: '',
};

export const loadShelving = createAsyncThunk('shelving/load', async () => {
  const [tiers, containers, intakes] = await Promise.all([
    db.shelfTiers.toArray(),
    db.containers.toArray(),
    db.shelfIntakes.toArray(),
  ]);
  tiers.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
  containers.sort((a, b) => b.updatedAt - a.updatedAt);
  intakes.sort((a, b) => b.updatedAt - a.updatedAt);
  return { tiers, containers, intakes };
});

export interface IntakeOptions {
  /** 模拟首装具瞬时失败（自动重试后成功） */
  simulateTransientFailure?: boolean;
  /** 模拟首装具持续失败（挂起后手动重试） */
  simulatePersistentFailure?: boolean;
}

function resolveWriter(options?: IntakeOptions): ContainerWriter {
  if (options?.simulatePersistentFailure) {
    return createSimulatedContainerWriter({ persistentFirst: true });
  }
  if (options?.simulateTransientFailure) {
    return createSimulatedContainerWriter({ transientFirst: true });
  }
  return {
    async writeContainer(container) {
      await db.containers.put(container);
    },
  };
}

export const runIntakeBatch = createAsyncThunk(
  'shelving/intake',
  async (payload: { lines: Array<{ collectionNo: string; measuredSize: string }>; options?: IntakeOptions }, { dispatch }) => {
    const result = await processShelfIntake(payload.lines, { writer: resolveWriter(payload.options) });
    await Promise.all([dispatch(loadShelving()), dispatch(loadRubbings())]);
    return result;
  },
);

export const claimIntake = createAsyncThunk(
  'shelving/claim',
  async (payload: { intakeId: string; rubbingId: string; options?: IntakeOptions }, { dispatch }) => {
    const result = await claimShelfIntake(payload.intakeId, payload.rubbingId, resolveWriter(payload.options));
    await Promise.all([dispatch(loadShelving()), dispatch(loadRubbings())]);
    return result;
  },
);

export const reshelveIntake = createAsyncThunk(
  'shelving/reshelve',
  async (payload: { intakeId: string; measuredSize: string | null; options?: IntakeOptions }, { dispatch }) => {
    const result = await shelvePendingIntake(payload.intakeId, payload.measuredSize, resolveWriter(payload.options));
    await Promise.all([dispatch(loadShelving()), dispatch(loadRubbings())]);
    return result;
  },
);

export const retryContainer = createAsyncThunk(
  'shelving/retryContainer',
  async (payload: { containerId: string }, { dispatch }) => {
    const result = await retryFailedContainer(payload.containerId);
    await dispatch(loadShelving());
    return result;
  },
);

export const deleteIntake = createAsyncThunk('shelving/deleteIntake', async (intakeId: string, { dispatch }) => {
  await removeShelfIntake(intakeId);
  await dispatch(loadShelving());
});

const shelvingSlice = createSlice({
  name: 'shelving',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(loadShelving.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadShelving.fulfilled, (state, action) => {
        state.tiers = action.payload.tiers;
        state.containers = action.payload.containers;
        state.intakes = action.payload.intakes;
        state.loading = false;
        state.ready = true;
        state.error = '';
      })
      .addCase(loadShelving.rejected, (state, action) => {
        state.loading = false;
        state.ready = true;
        state.error = action.error.message ?? '排架账读取失败';
      });
  },
});

export const selectShelvingState = (state: RootState): ShelvingState => state.shelving;
export const selectShelfTiers = (state: RootState): ShelfTier[] => state.shelving.tiers;
export const selectContainers = (state: RootState): Container[] => state.shelving.containers;
export const selectShelfIntakes = (state: RootState): ShelfIntake[] => state.shelving.intakes;

/** 写库失败挂起的装具 */
export function selectFailedContainers(state: RootState): Container[] {
  return state.shelving.containers.filter((container) => container.status === 'writeFailed');
}

export interface RubbingShelfPlacement {
  containerCode: string;
  containerId: string;
  status: Container['status'];
  tierCode: string;
  slotNo: number | null;
}

/**
 * 拓本 id → 装具位置（编目台侧展示库房排架位置用）。
 * 一件拓本至多在一个装具内；写库失败挂起的也能标出。
 */
export function selectRubbingPlacementMap(state: RootState): Map<string, RubbingShelfPlacement> {
  const tierById = new Map(state.shelving.tiers.map((tier) => [tier.id, tier]));
  const map = new Map<string, RubbingShelfPlacement>();
  state.shelving.containers.forEach((container) => {
    const tier = container.shelfTierId ? tierById.get(container.shelfTierId) : undefined;
    container.items.forEach((item) => {
      map.set(item.rubbingId, {
        containerCode: container.code,
        containerId: container.id,
        status: container.status,
        tierCode: tier?.code ?? '',
        slotNo: container.slotNo,
      });
    });
  });
  return map;
}

/** 按柜层分组的装具，附可读层名 */
export function selectContainersByTier(
  state: RootState,
): Array<{ tier: ShelfTier; label: string; containers: Container[] }> {
  return state.shelving.tiers
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
    .map((tier) => ({
      tier,
      label: describeShelfTier(tier.cabinetNo, tier.tierNo),
      containers: state.shelving.containers
        .filter((container) => container.shelfTierId === tier.id)
        .sort((a, b) => (a.slotNo ?? 0) - (b.slotNo ?? 0)),
    }));
}

export default shelvingSlice.reducer;
