/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑（v1 → v2：Loss 增加 charNo 与复合索引，并按行号顺序重建历史字位记录；
 *   v2 → v3：接入库房排架——旧拓本无装具号，按尺寸先粗分，分不上的留待上架）
 * - 八张业务表的增删改查与整库导入导出
 * - 首次打开自动播种三层互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table, type Transaction } from 'dexie';
import type { Stele } from '@/types/stele';
import type { Rubbing } from '@/types/rubbing';
import type { Loss } from '@/types/loss';
import type { Seal } from '@/types/seal';
import type { Compare } from '@/types/compare';
import type { Container, ShelfEntry, ShelfLayer } from '@/types/shelf';
import { bucketOfSize } from './shelfPack';
import { sortLosses } from './collate';

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gbrubbing';

/** 当前数据结构版本号 */
export const DB_SCHEMA_VERSION = 3;

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gbrubbing:db-version',
  lastBackupAt: 'gbrubbing:last-backup-at',
  uiPrefs: 'gbrubbing:ui-prefs',
} as const;

export interface UiPrefs {
  lastSteleId: string | null;
  lastRubbingId: string | null;
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastSteleId: null, lastRubbingId: null };

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return {
      lastSteleId: typeof parsed.lastSteleId === 'string' ? parsed.lastSteleId : null,
      lastRubbingId: typeof parsed.lastRubbingId === 'string' ? parsed.lastRubbingId : null,
    };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_SCHEMA_VERSION));
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value);
  } catch {
    /* ignore */
  }
}

class RubbingDatabase extends Dexie {
  steles!: Table<Stele, string>;
  rubbings!: Table<Rubbing, string>;
  losses!: Table<Loss, string>;
  seals!: Table<Seal, string>;
  compares!: Table<Compare, string>;
  shelfLayers!: Table<ShelfLayer, string>;
  shelfContainers!: Table<Container, string>;
  shelfEntries!: Table<ShelfEntry, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（历史字位记录仅有 lineNo）
    this.version(1).stores({
      steles: 'id, title, era, form, updatedAt',
      rubbings: 'id, steleId, versionNo, method, state, updatedAt',
      losses: 'id, rubbingId, lineNo, type, severity, updatedAt',
      seals: 'id, rubbingId, sealType, updatedAt',
      compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, updatedAt',
    });

    // v2：Loss 增加 charNo 与 [rubbingId+lineNo+charNo] 复合索引，并按行号顺序重建历史字位记录
    this.version(2)
      .stores({
        steles: 'id, title, era, form, location, updatedAt',
        rubbings: 'id, steleId, versionNo, method, inkTone, state, updatedAt',
        losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, updatedAt',
        seals: 'id, rubbingId, sealType, position, updatedAt',
        compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, updatedAt',
      })
      .upgrade(async (tx) => {
        const table = tx.table<Loss>('losses');
        const all = await table.toArray();
        const byRubbing = new Map<string, Loss[]>();
        all.forEach((loss) => {
          byRubbing.set(loss.rubbingId, [...(byRubbing.get(loss.rubbingId) ?? []), loss]);
        });
        const rebuilt: Loss[] = [];
        byRubbing.forEach((list) => {
          // 按行号排序后，为缺失 charNo 的历史记录在行内顺序补位
          const sorted = [...list].sort((a, b) => a.lineNo - b.lineNo);
          const counter = new Map<number, number>();
          sorted.forEach((loss) => {
            const used = counter.get(loss.lineNo) ?? 0;
            const charNo = typeof loss.charNo === 'number' && loss.charNo > 0 ? loss.charNo : used + 1;
            counter.set(loss.lineNo, Math.max(used, charNo));
            rebuilt.push({ ...loss, charNo, updatedAt: Date.now() });
          });
        });
        await table.bulkPut(sortLosses(rebuilt));
      });

    // v3：接入库房排架账（层 / 装具 / 排架条目）。
    // 旧拓本没有装具号：升级时按编目尺寸先粗分（大/中/小件），先记着不上架；
    // 尺寸分不上的（缺尺寸 / 单件超装具 / 不可辨）留待上架，等人按库房实测重分。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        steles: 'id, title, era, form, location, updatedAt',
        rubbings: 'id, steleId, versionNo, method, inkTone, state, updatedAt',
        losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, updatedAt',
        seals: 'id, rubbingId, sealType, position, updatedAt',
        compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, updatedAt',
        shelfLayers: 'id, seq, slotsUsed, updatedAt',
        shelfContainers: 'id, sequenceNo, bucket, layerId, slotNo, status, updatedAt',
        shelfEntries: 'id, rubbingId, collectionNo, containerId, bucket, status, updatedAt',
      })
      .upgrade(async (tx) => {
        const rubbingTable = tx.table<Rubbing>('rubbings');
        const entryTable = tx.table<ShelfEntry>('shelfEntries');
        const legacy = await rubbingTable.toArray();
        const now = Date.now();
        const entries: ShelfEntry[] = legacy
          .filter((rubbing) => rubbing.collectionNo && rubbing.collectionNo.trim().length > 0)
          .map((rubbing, index) => {
            const bucket = bucketOfSize(rubbing.sizeCm);
            const pendingShelf = bucket === null;
            return {
              id: `shent_upgrade_${index + 1}`,
              collectionNo: rubbing.collectionNo,
              rubbingId: rubbing.id,
              // 旧拓本只有编目尺寸，库房实测留空，等排架账对账时以库房量的为准
              measuredSizeCm: '',
              catalogSizeCmSnapshot: rubbing.sizeCm,
              bucket,
              containerId: null,
              status: pendingShelf ? 'pendingShelf' : 'pending',
              attempts: 0,
              lastError: '',
              note: pendingShelf ? '旧拓本升级：尺寸分不上，留待上架' : '旧拓本升级：按编目尺寸粗分，待库房实测对账',
              createdAt: now,
              updatedAt: now,
            };
          });
        if (entries.length > 0) await entryTable.bulkPut(entries);
      });
  }
}

export const db = new RubbingDatabase();

/** 生成主键：短前缀 + 时间戳 + 随机串 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  stampDbVersion();
  if ((await db.steles.count()) === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Stele → Rubbing →（Loss / Seal）＋ Stele → Compare */

export async function seedDatabase(): Promise<void> {
  const now = Date.now();
  const day = 86400000;

  const steles: Stele[] = [
    {
      id: 'stele_01',
      title: '礼器碑',
      era: '东汉永寿二年',
      location: '山东曲阜孔庙',
      form: 'stele',
      sizeCm: '227×93',
      calligrapher: '佚名（隶书）',
      createdAt: now - day * 60,
      updatedAt: now - day * 3,
    },
    {
      id: 'stele_02',
      title: '石门颂',
      era: '东汉建和二年',
      location: '陕西汉中石门',
      form: 'cliff',
      sizeCm: '261×205',
      calligrapher: '王升（隶书）',
      createdAt: now - day * 48,
      updatedAt: now - day * 2,
    },
    {
      id: 'stele_03',
      title: '颜勤礼碑',
      era: '唐大历十四年',
      location: '陕西西安碑林',
      form: 'stele',
      sizeCm: '268×92',
      calligrapher: '颜真卿（楷书）',
      createdAt: now - day * 36,
      updatedAt: now - day,
    },
  ];

  const rubbings: Rubbing[] = [
    { id: 'rub_0101', steleId: 'stele_01', versionNo: 1, method: 'rub', paperType: '宣纸', inkTone: 'thick', sizeCm: '210×88', collectionNo: 'TB-0101', dateGuess: '明拓', state: 'cataloged', createdAt: now - day * 50, updatedAt: now - day * 10 },
    { id: 'rub_0102', steleId: 'stele_01', versionNo: 2, method: 'cicada', paperType: '棉连纸', inkTone: 'light', sizeCm: '208×86', collectionNo: 'TB-0102', dateGuess: '清拓', state: 'toCompare', createdAt: now - day * 44, updatedAt: now - day * 6 },
    { id: 'rub_0201', steleId: 'stele_02', versionNo: 1, method: 'pat', paperType: '皮纸', inkTone: 'thick', sizeCm: '250×196', collectionNo: 'TB-0201', dateGuess: '清中期拓', state: 'cataloged', createdAt: now - day * 40, updatedAt: now - day * 5 },
    { id: 'rub_0202', steleId: 'stele_02', versionNo: 2, method: 'rub', paperType: '棉连纸', inkTone: 'light', sizeCm: '248×194', collectionNo: 'TB-0202', dateGuess: '清晚期拓', state: 'toCatalog', createdAt: now - day * 34, updatedAt: now - day * 4 },
    { id: 'rub_0301', steleId: 'stele_03', versionNo: 1, method: 'rub', paperType: '净皮宣', inkTone: 'thick', sizeCm: '260×90', collectionNo: 'TB-0301', dateGuess: '民国拓', state: 'toCatalog', createdAt: now - day * 20, updatedAt: now - day * 2 },
  ];

  const losses: Loss[] = [
    { id: 'loss_010101', rubbingId: 'rub_0101', lineNo: 3, charNo: 7, type: 'blur', severity: 'light', note: '「壽」字右下漫漶', createdAt: now - day * 30, updatedAt: now - day * 30 },
    { id: 'loss_010102', rubbingId: 'rub_0101', lineNo: 5, charNo: 2, type: 'stoneFlower', severity: 'medium', note: '石花漫及「年」字', createdAt: now - day * 30, updatedAt: now - day * 29 },
    { id: 'loss_010103', rubbingId: 'rub_0101', lineNo: 9, charNo: 11, type: 'missing', severity: 'heavy', note: '「禮」字缺末笔', createdAt: now - day * 28, updatedAt: now - day * 28 },
    { id: 'loss_010201', rubbingId: 'rub_0102', lineNo: 3, charNo: 7, type: 'blur', severity: 'medium', note: '晚拓，「壽」字已损', createdAt: now - day * 24, updatedAt: now - day * 24 },
    { id: 'loss_010202', rubbingId: 'rub_0102', lineNo: 9, charNo: 11, type: 'missing', severity: 'heavy', note: '「禮」字全缺', createdAt: now - day * 24, updatedAt: now - day * 22 },
    { id: 'loss_010203', rubbingId: 'rub_0102', lineNo: 12, charNo: 4, type: 'crack', severity: 'medium', note: '碑面斜裂一道', createdAt: now - day * 22, updatedAt: now - day * 22 },
    { id: 'loss_020101', rubbingId: 'rub_0201', lineNo: 2, charNo: 5, type: 'crack', severity: 'light', note: '崖面细裂', createdAt: now - day * 18, updatedAt: now - day * 18 },
    { id: 'loss_020201', rubbingId: 'rub_0202', lineNo: 2, charNo: 5, type: 'crack', severity: 'light', note: '崖面细裂（同前）', createdAt: now - day * 20, updatedAt: now - day * 20 },
    { id: 'loss_020202', rubbingId: 'rub_0202', lineNo: 6, charNo: 3, type: 'blur', severity: 'medium', note: '晚拓，「頌」字已漫漶', createdAt: now - day * 18, updatedAt: now - day * 18 },
    { id: 'loss_030101', rubbingId: 'rub_0301', lineNo: 4, charNo: 3, type: 'blur', severity: 'heavy', note: '民国拓，字口已平', createdAt: now - day * 10, updatedAt: now - day * 10 },
  ];

  const seals: Seal[] = [
    { id: 'seal_0101', rubbingId: 'rub_0101', sealText: '端方藏碑', position: '右下角', transcription: '端方（匋斋）收藏印', sealType: 'collection', createdAt: now - day * 40, updatedAt: now - day * 40 },
    { id: 'seal_0102', rubbingId: 'rub_0101', sealText: '匋斋鉴赏', position: '左下角', transcription: '端方鉴赏印', sealType: 'appraisal', createdAt: now - day * 40, updatedAt: now - day * 40 },
    { id: 'seal_0103', rubbingId: 'rub_0102', sealText: '艺风堂', position: '卷尾', transcription: '缪荃孙艺风堂藏书印', sealType: 'collection', createdAt: now - day * 30, updatedAt: now - day * 30 },
    { id: 'seal_0201', rubbingId: 'rub_0201', sealText: '石门旧拓', position: '左上角', transcription: '藏家自钤印', sealType: 'author', createdAt: now - day * 26, updatedAt: now - day * 26 },
  ];

  const compares: Compare[] = [
    { id: 'cmp_0101', steleId: 'stele_01', rubbingIdA: 'rub_0101', rubbingIdB: 'rub_0102', diffCount: 3, conclusion: 'early', operator: '傅砚', date: '2026-03-06', createdAt: now - day * 5, updatedAt: now - day * 5 },
    { id: 'cmp_0201', steleId: 'stele_02', rubbingIdA: 'rub_0201', rubbingIdB: 'rub_0202', diffCount: 1, conclusion: 'late', operator: '傅砚', date: '2026-03-08', createdAt: now - day * 3, updatedAt: now - day * 3 },
  ];

  // 库房排架账：一层固定摆 4 个装具；大件装具 960cm、中件 720cm 上限
  const shelfLayers: ShelfLayer[] = [
    { id: 'slayer_seed_1', seq: 1, name: '第 1 层', slotCount: 4, slotsUsed: 2, createdAt: now - day * 2, updatedAt: now - day * 1 },
  ];

  const shelfContainers: Container[] = [
    { id: 'sctr_seed_001', code: '装具-001', sequenceNo: 1, bucket: 'large', sizeLimitCm: 960, totalSizeCm: 500, layerId: 'slayer_seed_1', slotNo: 1, status: 'ready', attempts: 0, lastError: '', createdAt: now - day * 2, updatedAt: now - day * 1 },
    { id: 'sctr_seed_002', code: '装具-002', sequenceNo: 2, bucket: 'medium', sizeLimitCm: 720, totalSizeCm: 418, layerId: 'slayer_seed_1', slotNo: 2, status: 'ready', attempts: 0, lastError: '', createdAt: now - day * 2, updatedAt: now - day * 1 },
  ];

  const shelfEntries: ShelfEntry[] = [
    { id: 'shent_seed_0201', collectionNo: 'TB-0201', rubbingId: 'rub_0201', measuredSizeCm: '252×196', catalogSizeCmSnapshot: '250×196', bucket: 'large', containerId: 'sctr_seed_001', status: 'shelved', attempts: 1, lastError: '', note: '库房实测 252×196，尺寸以库房为准', createdAt: now - day * 2, updatedAt: now - day * 1 },
    { id: 'shent_seed_0202', collectionNo: 'TB-0202', rubbingId: 'rub_0202', measuredSizeCm: '248×194', catalogSizeCmSnapshot: '248×194', bucket: 'large', containerId: 'sctr_seed_001', status: 'shelved', attempts: 1, lastError: '', note: '', createdAt: now - day * 2, updatedAt: now - day * 1 },
    { id: 'shent_seed_0101', collectionNo: 'TB-0101', rubbingId: 'rub_0101', measuredSizeCm: '210×88', catalogSizeCmSnapshot: '210×88', bucket: 'medium', containerId: 'sctr_seed_002', status: 'shelved', attempts: 1, lastError: '', note: '', createdAt: now - day * 2, updatedAt: now - day * 1 },
    { id: 'shent_seed_0102', collectionNo: 'TB-0102', rubbingId: 'rub_0102', measuredSizeCm: '208×86', catalogSizeCmSnapshot: '208×86', bucket: 'medium', containerId: 'sctr_seed_002', status: 'shelved', attempts: 1, lastError: '', note: '', createdAt: now - day * 2, updatedAt: now - day * 1 },
    { id: 'shent_seed_0301', collectionNo: 'TB-0301', rubbingId: 'rub_0301', measuredSizeCm: '260×90', catalogSizeCmSnapshot: '260×90', bucket: 'large', containerId: null, status: 'pending', attempts: 0, lastError: '', note: '已粗分，待装入装具', createdAt: now - day * 1, updatedAt: now - day * 1 },
    { id: 'shent_seed_claim', collectionNo: 'TB-9009', rubbingId: null, measuredSizeCm: '205×85', catalogSizeCmSnapshot: '', bucket: 'medium', containerId: null, status: 'pendingClaim', attempts: 0, lastError: '', note: '排架账上认不出对应拓本，等人认领', createdAt: now - day * 1, updatedAt: now - day * 1 },
    { id: 'shent_seed_hold', collectionNo: 'TB-9010', rubbingId: null, measuredSizeCm: '尺寸待补', catalogSizeCmSnapshot: '', bucket: null, containerId: null, status: 'pendingShelf', attempts: 0, lastError: '', note: '尺寸分不上，留待上架', createdAt: now - day * 1, updatedAt: now - day * 1 },
  ];

  await db.transaction('rw', [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.shelfLayers, db.shelfContainers, db.shelfEntries], async () => {
    await db.steles.bulkPut(steles);
    await db.rubbings.bulkPut(rubbings);
    await db.losses.bulkPut(losses);
    await db.seals.bulkPut(seals);
    await db.compares.bulkPut(compares);
    await db.shelfLayers.bulkPut(shelfLayers);
    await db.shelfContainers.bulkPut(shelfContainers);
    await db.shelfEntries.bulkPut(shelfEntries);
  });
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface RubbingSnapshot {
  app: typeof DB_NAME;
  schemaVersion: number;
  exportedAt: string;
  steles: Stele[];
  rubbings: Rubbing[];
  losses: Loss[];
  seals: Seal[];
  compares: Compare[];
  shelfLayers: ShelfLayer[];
  shelfContainers: Container[];
  shelfEntries: ShelfEntry[];
}

export async function exportSnapshot(): Promise<RubbingSnapshot> {
  const [steles, rubbings, losses, seals, compares, shelfLayers, shelfContainers, shelfEntries] = await Promise.all([
    db.steles.toArray(),
    db.rubbings.toArray(),
    db.losses.toArray(),
    db.seals.toArray(),
    db.compares.toArray(),
    db.shelfLayers.toArray(),
    db.shelfContainers.toArray(),
    db.shelfEntries.toArray(),
  ]);
  return {
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    steles,
    rubbings,
    losses,
    seals,
    compares,
    shelfLayers,
    shelfContainers,
    shelfEntries,
  };
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const snapshot = input as Partial<RubbingSnapshot>;
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`;
  const keys: Array<keyof RubbingSnapshot> = ['steles', 'rubbings', 'losses', 'seals', 'compares'];
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`;
  }
  return '';
}

/** 旧备份（v2 及以前，无排架账三表）导入时补空集合，不强制升级旧数据 */
function normalizeSnapshot(snapshot: RubbingSnapshot): RubbingSnapshot {
  return {
    ...snapshot,
    shelfLayers: Array.isArray(snapshot.shelfLayers) ? snapshot.shelfLayers : [],
    shelfContainers: Array.isArray(snapshot.shelfContainers) ? snapshot.shelfContainers : [],
    shelfEntries: Array.isArray(snapshot.shelfEntries) ? snapshot.shelfEntries : [],
  };
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.shelfLayers, db.shelfContainers, db.shelfEntries],
    async () => {
      await Promise.all([
        db.steles.clear(),
        db.rubbings.clear(),
        db.losses.clear(),
        db.seals.clear(),
        db.compares.clear(),
        db.shelfLayers.clear(),
        db.shelfContainers.clear(),
        db.shelfEntries.clear(),
      ]);
    },
  );
}

export async function importSnapshot(raw: RubbingSnapshot): Promise<void> {
  const snapshot = normalizeSnapshot(raw);
  await clearAllTables();
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.shelfLayers, db.shelfContainers, db.shelfEntries],
    async () => {
      await db.steles.bulkPut(snapshot.steles);
      await db.rubbings.bulkPut(snapshot.rubbings);
      await db.losses.bulkPut(snapshot.losses);
      await db.seals.bulkPut(snapshot.seals);
      await db.compares.bulkPut(snapshot.compares);
      await db.shelfLayers.bulkPut(snapshot.shelfLayers);
      await db.shelfContainers.bulkPut(snapshot.shelfContainers);
      await db.shelfEntries.bulkPut(snapshot.shelfEntries);
    },
  );
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [steles, rubbings, losses, seals, compares, shelfLayers, shelfContainers, shelfEntries] = await Promise.all([
    db.steles.count(),
    db.rubbings.count(),
    db.losses.count(),
    db.seals.count(),
    db.compares.count(),
    db.shelfLayers.count(),
    db.shelfContainers.count(),
    db.shelfEntries.count(),
  ]);
  return { steles, rubbings, losses, seals, compares, shelfLayers, shelfContainers, shelfEntries };
}

/**
 * 拓本从编目台删除时，排架账不销账：
 * 实物已在就绪装具里的条目留在原装具（rubbingId 解绑、状态保持在架）；
 * 其余（含未上架、写库失败装具里的）转待认领，等人核对。
 * 编目台的拓法 / 损泐字位随拓本删除。
 */
async function detachShelfEntriesByRubbing(rubbingIds: string[], tx: Transaction): Promise<void> {
  const rows = await tx.table<ShelfEntry>('shelfEntries').where('rubbingId').anyOf(rubbingIds).toArray();
  const containerRows = await tx.table<Container>('shelfContainers').toArray();
  const containerStatusById = new Map(containerRows.map((container) => [container.id, container.status]));
  const now = Date.now();
  await tx.table<ShelfEntry>('shelfEntries').bulkPut(
    rows.map((row) => {
      const staysShelved = row.containerId !== null && containerStatusById.get(row.containerId) === 'ready';
      return {
        ...row,
        rubbingId: null,
        status: staysShelved ? 'shelved' : 'pendingClaim',
        note: staysShelved
          ? '拓本已从编目台删除，实物留在原装具，等人认领'
          : row.containerId
            ? '拓本已从编目台删除，写库未确认，等人认领'
            : '拓本已从编目台删除，等人认领',
        updatedAt: now,
      };
    }),
  );
}

/** 级联删除碑刻 → 拓本 → 损泐 / 钤印 / 比对；排架账条目解绑后留待认领 */
export async function removeSteleCascade(steleId: string): Promise<void> {
  const rubbingIds = (await db.rubbings.where('steleId').equals(steleId).toArray()).map((row) => row.id);
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.shelfEntries, db.shelfContainers],
    async (tx) => {
      if (rubbingIds.length > 0) {
        await db.losses.where('rubbingId').anyOf(rubbingIds).delete();
        await db.seals.where('rubbingId').anyOf(rubbingIds).delete();
        await detachShelfEntriesByRubbing(rubbingIds, tx);
      }
      await db.rubbings.where('steleId').equals(steleId).delete();
      await db.compares.where('steleId').equals(steleId).delete();
      await db.steles.delete(steleId);
    },
  );
}

/** 级联删除拓本 → 损泐 / 钤印 / 涉及的比对记录；排架账条目解绑后留待认领 */
export async function removeRubbingCascade(rubbingId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.rubbings, db.losses, db.seals, db.compares, db.shelfEntries, db.shelfContainers],
    async (tx) => {
      await db.losses.where('rubbingId').equals(rubbingId).delete();
      await db.seals.where('rubbingId').equals(rubbingId).delete();
      const compares = await tx.table<Compare>('compares').toArray();
      const affected = compares.filter((row) => row.rubbingIdA === rubbingId || row.rubbingIdB === rubbingId);
      if (affected.length > 0) await tx.table<Compare>('compares').bulkDelete(affected.map((row) => row.id));
      await detachShelfEntriesByRubbing([rubbingId], tx);
      await db.rubbings.delete(rubbingId);
    },
  );
}

/** 重排某碑刻下拓本的版本序号，保证连续 */
export async function renumberRubbings(steleId: string): Promise<void> {
  const rows = await db.rubbings.where('steleId').equals(steleId).toArray();
  const sorted = [...rows].sort((a, b) => (a.versionNo === b.versionNo ? a.createdAt - b.createdAt : a.versionNo - b.versionNo));
  await db.rubbings.bulkPut(sorted.map((row, index) => ({ ...row, versionNo: index + 1, updatedAt: Date.now() })));
}
