/**
 * Redux store 组装与类型化 hooks
 * 组装 stele / rubbing / loss 三个 reducer，并提供首屏一次性载入 thunk。
 */
import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';
import steleReducer, { loadSteles } from './steleSlice';
import rubbingReducer, { loadRubbings } from './rubbingSlice';
import lossReducer, { loadLosses } from './lossSlice';

export const store = configureStore({
  reducer: {
    stele: steleReducer,
    rubbing: rubbingReducer,
    loss: lossReducer,
  },
});

/** 首屏载入：一次性拉取三张表，保证页面打开即有数据 */
export const loadAll = () => async (dispatch: AppDispatch): Promise<void> => {
  await Promise.all([dispatch(loadSteles()), dispatch(loadRubbings()), dispatch(loadLosses())]);
};

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

/** 类型化 hooks：页面统一使用，禁止直接使用未类型化的 useDispatch/useSelector */
export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

export default store;
