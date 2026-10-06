/**
 * useIdbTable：Dexie 单表增删改查 + liveQuery 响应式订阅封装
 * 被全部页面消费；页面不直接触碰 Dexie 实例。
 */
import { liveQuery } from 'dexie';
import type { Table } from 'dexie';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createId, db } from '@/utils/db';

export interface IdbRecord {
  id: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface UseIdbTableOptions {
  /** 是否按 updatedAt 倒序，默认 true */
  sortByUpdatedAt?: boolean;
}

export interface UseIdbTableResult<T extends IdbRecord> {
  rows: T[];
  loading: boolean;
  /** 是否完成首次载入：用于区分「数据为空」与「尚未读取」 */
  ready: boolean;
  error: string;
  refresh: () => Promise<void>;
  getById: (id: string) => Promise<T | undefined>;
  list: () => Promise<T[]>;
  create: (payload: Omit<T, 'id' | 'createdAt' | 'updatedAt'> & Partial<IdbRecord>, idPrefix?: string) => Promise<T>;
  update: (id: string, patch: Partial<T>) => Promise<void>;
  upsert: (row: T) => Promise<void>;
  remove: (id: string) => Promise<void>;
  bulkRemove: (ids: string[]) => Promise<void>;
  bulkPut: (rows: T[]) => Promise<void>;
  clear: () => Promise<void>;
}

export function useIdbTable<T extends IdbRecord>(
  tableSelector: (database: typeof db) => Table<T, string>,
  options: UseIdbTableOptions = {},
): UseIdbTableResult<T> {
  const { sortByUpdatedAt = true } = options;
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  // 页面通常传内联选择器（引用每次渲染都变），用 ref 固定表引用，避免订阅反复重建
  const selectorRef = useRef(tableSelector);
  selectorRef.current = tableSelector;
  const table = useMemo(() => selectorRef.current(db), []);

  const sort = useCallback(
    (list: T[]): T[] =>
      sortByUpdatedAt ? [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)) : [...list],
    [sortByUpdatedAt],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setRows(sort(await table.toArray()));
      setError('');
      setReady(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取本地数据失败');
    } finally {
      setLoading(false);
    }
  }, [sort, table]);

  useEffect(() => {
    let disposed = false;
    const subscription = liveQuery(async () => sort(await table.toArray())).subscribe({
      next: (list) => {
        if (disposed) return;
        setRows(list);
        setError('');
        setReady(true);
      },
      error: (err: unknown) => {
        if (disposed) return;
        setError(err instanceof Error ? err.message : '订阅本地数据失败');
      },
    });
    void refresh();
    return () => {
      disposed = true;
      subscription.unsubscribe();
    };
  }, [refresh, sort, table]);

  const create = useCallback<UseIdbTableResult<T>['create']>(
    async (payload, idPrefix = 'row') => {
      const now = Date.now();
      const record = {
        ...(payload as object),
        id: payload.id ?? createId(idPrefix),
        createdAt: payload.createdAt ?? now,
        updatedAt: payload.updatedAt ?? now,
      } as T;
      await table.put(record);
      return record;
    },
    [table],
  );

  const update = useCallback<UseIdbTableResult<T>['update']>(
    async (id, patch) => {
      await table.update(id, { ...patch, updatedAt: Date.now() } as never);
    },
    [table],
  );

  const upsert = useCallback<UseIdbTableResult<T>['upsert']>(
    async (row) => {
      await table.put({ ...row, updatedAt: Date.now() } as T);
    },
    [table],
  );

  const remove = useCallback<UseIdbTableResult<T>['remove']>(
    async (id) => {
      await table.delete(id);
    },
    [table],
  );

  const bulkRemove = useCallback<UseIdbTableResult<T>['bulkRemove']>(
    async (ids) => {
      await table.bulkDelete(ids);
    },
    [table],
  );

  const bulkPut = useCallback<UseIdbTableResult<T>['bulkPut']>(
    async (list) => {
      await table.bulkPut(list);
    },
    [table],
  );

  const clear = useCallback(async (): Promise<void> => {
    await table.clear();
  }, [table]);

  return {
    rows,
    loading,
    ready,
    error,
    refresh,
    getById: (id: string) => table.get(id),
    list: () => table.toArray(),
    create,
    update,
    upsert,
    remove,
    bulkRemove,
    bulkPut,
    clear,
  };
}

export default useIdbTable;
