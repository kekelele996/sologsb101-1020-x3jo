/**
 * 碑刻 slice（Redux Toolkit）
 * 维护碑刻列表、当前碑刻与筛选条件；跨页状态不留在组件内 useState。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createId, db, removeSteleCascade } from '@/utils/db';
import type { Stele, SteleDraft, SteleForm } from '@/types/stele';
import type { RootState } from './store';

export interface SteleFilters {
  keyword: string;
  eras: string[];
  forms: SteleForm[];
}

export interface SteleState {
  items: Stele[];
  loading: boolean;
  ready: boolean;
  error: string;
  currentSteleId: string | null;
  filters: SteleFilters;
}

const initialState: SteleState = {
  items: [],
  loading: false,
  ready: false,
  error: '',
  currentSteleId: null,
  filters: { keyword: '', eras: [], forms: [] },
};

export const loadSteles = createAsyncThunk('stele/load', async () => {
  const rows = await db.steles.toArray();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
});

export const createStele = createAsyncThunk('stele/create', async (draft: SteleDraft, { dispatch }) => {
  const now = Date.now();
  const row: Stele = { ...draft, id: createId('stele'), createdAt: now, updatedAt: now };
  await db.steles.put(row);
  await dispatch(loadSteles());
  return row;
});

export const updateStele = createAsyncThunk(
  'stele/update',
  async (payload: { id: string; patch: Partial<Stele> }, { dispatch }) => {
    await db.steles.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    await dispatch(loadSteles());
  },
);

export const removeStele = createAsyncThunk('stele/remove', async (id: string, { dispatch }) => {
  await removeSteleCascade(id);
  await dispatch(loadSteles());
});

const steleSlice = createSlice({
  name: 'stele',
  initialState,
  reducers: {
    setCurrentStele(state, action: PayloadAction<string | null>) {
      state.currentSteleId = action.payload;
    },
    setSteleKeyword(state, action: PayloadAction<string>) {
      state.filters.keyword = action.payload;
    },
    setSteleEras(state, action: PayloadAction<string[]>) {
      state.filters.eras = action.payload;
    },
    setSteleForms(state, action: PayloadAction<SteleForm[]>) {
      state.filters.forms = action.payload;
    },
    resetSteleFilters(state) {
      state.filters = { keyword: '', eras: [], forms: [] };
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadSteles.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadSteles.fulfilled, (state, action) => {
        state.items = action.payload;
        state.loading = false;
        state.ready = true;
        state.error = '';
        const exists = state.currentSteleId !== null && action.payload.some((row) => row.id === state.currentSteleId);
        if (!exists) state.currentSteleId = action.payload[0]?.id ?? null;
      })
      .addCase(loadSteles.rejected, (state, action) => {
        state.loading = false;
        state.ready = true;
        state.error = action.error.message ?? '碑刻读取失败';
      });
  },
});

export const { setCurrentStele, setSteleKeyword, setSteleEras, setSteleForms, resetSteleFilters } = steleSlice.actions;

export const selectSteleState = (state: RootState): SteleState => state.stele;
export const selectSteles = (state: RootState): Stele[] => state.stele.items;
export const selectCurrentSteleId = (state: RootState): string | null => state.stele.currentSteleId;

/** 派生选择器：关键字 + 年代 + 形制筛选 */
export function selectFilteredSteles(state: RootState): Stele[] {
  const { items, filters } = state.stele;
  const keyword = filters.keyword.trim();
  return items.filter((stele) => {
    if (keyword.length > 0) {
      const haystack = `${stele.title}${stele.era}${stele.location}${stele.calligrapher}`;
      if (!haystack.includes(keyword)) return false;
    }
    if (filters.eras.length > 0 && !filters.eras.includes(stele.era)) return false;
    if (filters.forms.length > 0 && !filters.forms.includes(stele.form)) return false;
    return true;
  });
}

/** 年代候选 */
export function selectEraOptions(state: RootState): string[] {
  return Array.from(new Set(state.stele.items.map((stele) => stele.era).filter((era) => era.length > 0))).sort();
}

export default steleSlice.reducer;
