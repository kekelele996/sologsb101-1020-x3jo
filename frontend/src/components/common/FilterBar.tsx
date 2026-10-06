/**
 * <FilterBar> 筛选条
 * 关键字 + 多选下拉过滤，并把条件同步到 URL query（useFilterQuery）；
 * 被道次页、荫房页、镶嵌页消费。
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Input, Select, Space, Tag } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';

export interface FilterSelectOption {
  value: string;
  label: string;
}

export interface FilterSelectConfig {
  /** query key，同时作为组件内唯一标识 */
  key: string;
  label: string;
  options: ReadonlyArray<FilterSelectOption>;
  placeholder?: string;
  /** 单选（默认多选） */
  multiple?: boolean;
}

export interface FilterBarProps {
  keyword: string;
  onKeywordChange: (value: string) => void;
  selects?: ReadonlyArray<FilterSelectConfig>;
  /** key → 选中值；multiple 为 false 时取数组首项 */
  values?: Record<string, string[]>;
  onValuesChange?: (key: string, next: string[]) => void;
  onReset: () => void;
  keywordPlaceholder?: string;
  /** 右侧附加操作区 */
  actions?: ReactNode;
}

/** 统计已启用条件数量，用于「n 项条件」提示 */
export function countActiveFilters(keyword: string, values: Record<string, string[]>): number {
  const selectCount = Object.values(values).reduce((sum, list) => sum + list.length, 0);
  return selectCount + (keyword.trim().length > 0 ? 1 : 0);
}

export interface FilterQueryState {
  keyword: string;
  values: Record<string, string[]>;
  setKeyword: (value: string) => void;
  setValues: (key: string, next: string[]) => void;
  reset: () => void;
}

/**
 * 把筛选条件读写同步到 URL query。
 * keys 必须是模块级常量数组（引用稳定），否则会重复计算。
 */
export function useFilterQuery(keys: readonly string[]): FilterQueryState {
  const [searchParams, setSearchParams] = useSearchParams();
  const keyword = searchParams.get('kw') ?? '';

  const values = useMemo(() => {
    const result: Record<string, string[]> = {};
    keys.forEach((key) => {
      const raw = searchParams.get(key);
      result[key] = raw ? raw.split(',').filter((item) => item.length > 0) : [];
    });
    return result;
  }, [keys, searchParams]);

  const setKeyword = useCallback(
    (value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value.length > 0) next.set('kw', value);
          else next.delete('kw');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setValues = useCallback(
    (key: string, list: string[]) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (list.length > 0) next.set(key, list.join(','));
          else next.delete(key);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const reset = useCallback(() => {
    setSearchParams(new URLSearchParams(), { replace: true });
  }, [setSearchParams]);

  return { keyword, values, setKeyword, setValues, reset };
}

export function FilterBar({
  keyword,
  onKeywordChange,
  selects = [],
  values = {},
  onValuesChange,
  onReset,
  keywordPlaceholder = '搜索关键字…',
  actions,
}: FilterBarProps) {
  const activeCount = countActiveFilters(keyword, values);

  return (
    <div className="gb-filter-bar">
      <Space wrap size={12} style={{ flex: '1 1 560px' }}>
        <Input
          allowClear
          value={keyword}
          prefix={<SearchOutlined />}
          placeholder={keywordPlaceholder}
          style={{ width: 220 }}
          onChange={(event) => onKeywordChange(event.target.value)}
        />
        {selects.map((select) => (
          <Space key={select.key} size={6}>
            <span className="gb-filter-bar__label">{select.label}</span>
            <Select
              mode={select.multiple === false ? undefined : 'multiple'}
              allowClear
              maxTagCount="responsive"
              style={{ minWidth: 170 }}
              placeholder={select.placeholder ?? `选择${select.label}`}
              value={select.multiple === false ? (values[select.key]?.[0] ?? undefined) : (values[select.key] ?? [])}
              options={[...select.options]}
              onChange={(value: string | string[] | undefined) => {
                const next = Array.isArray(value) ? value : value === undefined ? [] : [value];
                onValuesChange?.(select.key, next);
              }}
            />
          </Space>
        ))}
      </Space>
      <Space wrap size={8}>
        {actions}
        {activeCount > 0 ? <Tag color="gold">{activeCount} 项条件</Tag> : null}
        <Button icon={<ReloadOutlined />} type="text" onClick={onReset}>
          重置
        </Button>
      </Space>
    </div>
  );
}

export default FilterBar;
