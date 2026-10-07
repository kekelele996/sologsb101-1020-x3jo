/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑：
 *   v1 → v2：Loss 增加 charNo 与复合索引，并按行号顺序重建历史字位记录
 *   v2 → v3：接入库房排架账（柜层 / 装具 / 入库流水），旧拓本无装具号，
 *            升级时按尺寸粗分装箱，分不上的留待上架
 * - 八张业务表的增删改查与整库导入导出
 * - 首次打开自动播种三层互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库；「库房写库」以装具写入器模拟，
 * 单个装具写库失败只重试这一个装具，编目台数据照旧不动、不回滚。
 */
import Dexie, { type Table, type Transaction } from 'dexie';
import type { Stele } from '@/types/stele';
import type { Rubbing } from '@/types/rubbing';
import type { Loss } from '@/types/loss';
import type { Seal } from '@/types/seal';
import type { Compare } from '@/types/compare';
import {
  CONTAINER_WRITE_MAX_ATTEMPTS,
  CONTAINER_RETRY_BASE_DELAY_MS,
  nextContainerCode,
  type Container,
  type ContainerItem,
} from '@/types/container';
import {
  TIER_SLOT_CAPACITY,
  tierCodeOf,
  type ShelfTier,
} from '@/types/shelfTier';
import type { ShelfIntake, ShelfIntakeSource, ShelfIntakeStatus } from '@/types/shelfIntake';
import { sortLosses } from './collate';
import {
  classifySizeBand,
  packShelfEntries,
  parseSizeCm,
  planContainerSlots,
  tierKey,
  type ShelfPackEntry,
  type SizeBand,
} from './shelving';

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
  shelfTiers!: Table<ShelfTier, string>;
  containers!: Table<Container, string>;
  shelfIntakes!: Table<ShelfIntake, string>;

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
    this.version(2).stores({
      steles: 'id, title, era, form, location, updatedAt',
      rubbings: 'id, steleId, versionNo, method, inkTone, state, updatedAt',
      losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, updatedAt',
      seals: 'id, rubbingId, sealType, position, updatedAt',
      compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, updatedAt',
    });

    // v3：接入库房排架账 —— 柜层（槽位定死）、装具（尺寸合计上限）、入库流水（含待认领）
    this.version(DB_SCHEMA_VERSION)
      .stores({
        steles: 'id, title, era, form, location, updatedAt',
        rubbings: 'id, steleId, versionNo, method, inkTone, state, collectionNo, updatedAt',
        losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, updatedAt',
        seals: 'id, rubbingId, sealType, position, updatedAt',
        compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, updatedAt',
        shelfTiers: 'id, code, cabinetNo, tierNo, slotCapacity, createdAt',
        containers: 'id, code, shelfTierId, slotNo, status, updatedAt',
        shelfIntakes: 'id, rubbingId, collectionNo, status, containerId, batchNo, source, updatedAt',
      })
      .upgrade(async (tx) => {
        // v2 的字位重建逻辑保持不变（v2.upgrade 在 v2→v3 时仍由 Dexie 按序执行）
        const lossTable = tx.table<Loss>('losses');
        const allLosses = await lossTable.toArray();
        const byRubbing = new Map<string, Loss[]>();
        allLosses.forEach((loss) => {
          byRubbing.set(loss.rubbingId, [...(byRubbing.get(loss.rubbingId) ?? []), loss]);
        });
        const rebuiltLosses: Loss[] = [];
        const needsRebuild = allLosses.some((loss) => typeof loss.charNo !== 'number' || loss.charNo <= 0);
        if (needsRebuild) {
          byRubbing.forEach((list) => {
            // 按行号排序后，为缺失 charNo 的历史记录在行内顺序补位
            const sorted = [...list].sort((a, b) => a.lineNo - b.lineNo);
            const counter = new Map<number, number>();
            sorted.forEach((loss) => {
              const used = counter.get(loss.lineNo) ?? 0;
              const charNo = typeof loss.charNo === 'number' && loss.charNo > 0 ? loss.charNo : used + 1;
              counter.set(loss.lineNo, Math.max(used, charNo));
              rebuiltLosses.push({ ...loss, charNo, updatedAt: Date.now() });
            });
          });
          await lossTable.bulkPut(sortLosses(rebuiltLosses));
        }

        // 旧拓本没有装具号：按尺寸先粗分（小 / 中 / 大三档），同档顺次装箱；分不上的留待上架
        await legacySplitOnUpgrade(tx);
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

/* ---------------------- v2→v3：旧拓本按尺寸粗分装箱 ---------------------- */

/**
 * 升级迁移专用：旧藏拓本无装具号，按长边尺寸粗分三档，
 * 各档内顺次装箱（放不下另起装具），柜层槽位照旧定死排；
 * 尺寸不可解析或单件即超装具上限的分不上，留待上架。
 */
async function legacySplitOnUpgrade(tx: Transaction): Promise<void> {
  const rubbings = await tx.table<Rubbing>('rubbings').toArray();
  if (rubbings.length === 0) return;

  const tierTable = tx.table<ShelfTier>('shelfTiers');
  const containerTable = tx.table<Container>('containers');
  const intakeTable = tx.table<ShelfIntake>('shelfIntakes');

  const now = Date.now();
  const batchNo = `PC-${compactDate(now)}-01`;

  const bands = new Map<SizeBand, Array<{ rubbing: Rubbing; lengthCm: number }>>();
  const pending: Rubbing[] = [];
  rubbings.forEach((rubbing) => {
    const parsed = parseSizeCm(rubbing.sizeCm);
    const band = classifySizeBand(parsed.longEdge);
    if (band === null || parsed.longEdge === null) {
      pending.push(rubbing);
      return;
    }
    bands.set(band, [...(bands.get(band) ?? []), { rubbing, lengthCm: parsed.longEdge }]);
  });

  const builtTiers: ShelfTier[] = [];
  const builtContainers: Container[] = [];
  const builtIntakes: ShelfIntake[] = [];
  const bandOrder: SizeBand[] = ['small', 'medium', 'large'];
  let containerSeq = 0;

  const ensureTiers = (placements: ReturnType<typeof planContainerSlots>): void => {
    placements.forEach((placement) => {
      const code = tierCodeOf(placement.cabinetNo, placement.tierNo);
      if (builtTiers.some((tier) => tier.code === code)) return;
      // id 必须全局唯一（播种数据也用 tier_a1 这类固定 id），用 createId 防撞
      builtTiers.push({
        id: createId('tier'),
        code,
        cabinetNo: placement.cabinetNo,
        tierNo: placement.tierNo,
        slotCapacity: TIER_SLOT_CAPACITY,
        createdAt: now,
        updatedAt: now,
      });
    });
  };

  bandOrder.forEach((band) => {
    const list = (bands.get(band) ?? [])
      .slice()
      .sort((a, b) => a.lengthCm - b.lengthCm || a.rubbing.id.localeCompare(b.rubbing.id));
    if (list.length === 0) return;
    const entries: ShelfPackEntry[] = list.map(({ rubbing, lengthCm }) => ({
      key: rubbing.id,
      rubbingId: rubbing.id,
      sizeCm: rubbing.sizeCm,
      lengthCm,
    }));
    const packed = packShelfEntries(entries, null);
    const placements = planContainerSlots(builtTiers, builtContainers, packed.groups.length);
    ensureTiers(placements);
    packed.groups.forEach((group, groupIndex) => {
      containerSeq += 1;
      const placement = placements[groupIndex];
      if (!placement) return;
      const code = `装具-${String(containerSeq).padStart(4, '0')}`;
      const tier = builtTiers.find(
        (item) => item.code === tierCodeOf(placement.cabinetNo, placement.tierNo),
      );
      const items: ContainerItem[] = group.entries.map((entry) => ({
        rubbingId: entry.rubbingId,
        sizeCm: entry.sizeCm,
        lengthCm: entry.lengthCm,
      }));
      const containerId = `box_legacy_${String(containerSeq).padStart(2, '0')}`;
      builtContainers.push({
        id: containerId,
        code,
        shelfTierId: tier?.id ?? null,
        slotNo: placement.slotNo,
        items,
        usedSizeCm: group.usedSizeCm,
        // 升级粗分的装具按已封箱处理，后续新入库另开在用装具
        status: 'closed',
        lastWriteError: '',
        attempts: 1,
        createdAt: now,
        updatedAt: now,
      });
      group.entries.forEach((entry) => {
        const rubbing = list.find((item) => item.rubbing.id === entry.rubbingId)?.rubbing;
        builtIntakes.push({
          id: `in_legacy_${entry.rubbingId}`,
          collectionNo: rubbing?.collectionNo ?? '',
          rubbingId: entry.rubbingId,
          measuredSize: entry.sizeCm,
          catalogSizeAtIntake: rubbing?.sizeCm ?? '',
          reconciled: false,
          status: 'shelved',
          containerId,
          batchNo,
          attempts: 1,
          lastWriteError: '',
          source: 'legacySplit',
          note: `旧藏升级按尺寸粗分入箱（${band}档）`,
          createdAt: now,
          updatedAt: now,
        });
      });
    });
  });

  // 分不上的：尺寸不可辨认或单件超规，单独留在流水里等待人工上架
  pending.forEach((rubbing, index) => {
    const reason = parseSizeCm(rubbing.sizeCm).longEdge === null ? '旧尺寸无法辨认，待库房补量' : '单件尺寸超过装具上限，需另配装具';
    builtIntakes.push({
      id: `in_legacy_pending_${rubbing.id}`,
      collectionNo: rubbing.collectionNo,
      rubbingId: rubbing.id,
      measuredSize: rubbing.sizeCm,
      catalogSizeAtIntake: rubbing.sizeCm,
      reconciled: false,
      status: 'pendingShelf',
      containerId: null,
      batchNo,
      attempts: 0,
      lastWriteError: '',
      source: 'legacySplit',
      note: `升级粗分时分不上，${reason}`,
      createdAt: now + index + 1,
      updatedAt: now + index + 1,
    });
  });

  await tierTable.bulkPut(builtTiers);
  await containerTable.bulkPut(builtContainers);
  await intakeTable.bulkPut(builtIntakes);
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Stele → Rubbing →（Loss / Seal）＋ Stele → Compare ＋ 库房排架账 */

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
      updatedAt: now - day * 1,
    },
  ];

  const rubbings: Rubbing[] = [
    { id: 'rub_0101', steleId: 'stele_01', versionNo: 1, method: 'rub', paperType: '宣纸', inkTone: 'thick', sizeCm: '210×88', collectionNo: 'TB-0101', dateGuess: '明拓', state: 'cataloged', createdAt: now - day * 50, updatedAt: now - day * 10 },
    { id: 'rub_0102', steleId: 'stele_01', versionNo: 2, method: 'cicada', paperType: '棉连纸', inkTone: 'light', sizeCm: '208×86', collectionNo: 'TB-0102', dateGuess: '清拓', state: 'toCompare', createdAt: now - day * 44, updatedAt: now - day * 6 },
    { id: 'rub_0201', steleId: 'stele_02', versionNo: 1, method: 'pat', paperType: '皮纸', inkTone: 'thick', sizeCm: '250×196', collectionNo: 'TB-0201', dateGuess: '清中期拓', state: 'cataloged', createdAt: now - day * 40, updatedAt: now - day * 5 },
    { id: 'rub_0202', steleId: 'stele_02', versionNo: 2, method: 'rub', paperType: '棉连纸', inkTone: 'light', sizeCm: '248×194', collectionNo: 'TB-0202', dateGuess: '清晚期拓', state: 'toCatalog', createdAt: now - day * 34, updatedAt: now - day * 4 },
    { id: 'rub_0301', steleId: 'stele_03', versionNo: 1, method: 'rub', paperType: '净皮宣', inkTone: 'thick', sizeCm: '260×90', collectionNo: 'TB-0301', dateGuess: '民国拓', state: 'toCatalog', createdAt: now - day * 20, updatedAt: now - day * 2 },
    { id: 'rub_0302', steleId: 'stele_03', versionNo: 2, method: 'rub', paperType: '棉连纸', inkTone: 'light', sizeCm: '205×87', collectionNo: 'TB-0302', dateGuess: '清初拓', state: 'cataloged', createdAt: now - day * 18, updatedAt: now - day * 2 },
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

  // 排架演示数据：若升级迁移已建柜层/装具（旧库升级后首次播种），
  // 则顺着已占用的槽位往后排，保证柜层码、槽位、装具号都不撞车。
  const [existingTiers, existingContainers] = await Promise.all([db.shelfTiers.toArray(), db.containers.toArray()]);

  const seedBoxSpecs: Array<{ id: string; items: Container['items']; usedSizeCm: number; status: Container['status']; daysAgo: number }> = [
    {
      id: 'box_0001',
      items: [
        { rubbingId: 'rub_0101', sizeCm: '210×88', lengthCm: 210 },
        { rubbingId: 'rub_0102', sizeCm: '208×86', lengthCm: 208 },
      ],
      usedSizeCm: 418,
      status: 'closed',
      daysAgo: 12,
    },
    {
      id: 'box_0002',
      items: [
        { rubbingId: 'rub_0201', sizeCm: '250×196', lengthCm: 250 },
        { rubbingId: 'rub_0202', sizeCm: '248×194', lengthCm: 248 },
      ],
      usedSizeCm: 498,
      status: 'closed',
      daysAgo: 11,
    },
    {
      id: 'box_0003',
      items: [{ rubbingId: 'rub_0301', sizeCm: '260×90', lengthCm: 260 }],
      usedSizeCm: 260,
      status: 'open',
      daysAgo: 2,
    },
  ];

  const seedPlacements = planContainerSlots(existingTiers, existingContainers, seedBoxSpecs.length);
  const seedTiers: ShelfTier[] = [];
  seedPlacements.forEach((placement) => {
    if (seedTiers.some((tier) => tier.code === tierCodeOf(placement.cabinetNo, placement.tierNo))) return;
    if (existingTiers.some((tier) => tier.code === tierCodeOf(placement.cabinetNo, placement.tierNo))) return;
    seedTiers.push({
      id: `tier_seed_${placement.cabinetNo}_${placement.tierNo}`,
      code: tierCodeOf(placement.cabinetNo, placement.tierNo),
      cabinetNo: placement.cabinetNo,
      tierNo: placement.tierNo,
      slotCapacity: TIER_SLOT_CAPACITY,
      createdAt: now - day * 12,
      updatedAt: now - day * 12,
    });
  });
  const allSeedTiers = [...existingTiers, ...seedTiers];

  const codeSeed: Array<Pick<Container, 'code'>> = [...existingContainers];
  const containers: Container[] = seedBoxSpecs.map((spec, index) => {
    const placement = seedPlacements[index];
    const tier = placement
      ? allSeedTiers.find((item) => item.code === tierCodeOf(placement.cabinetNo, placement.tierNo))
      : undefined;
    // 装具号顺着现有号段往后排，避开迁移已占用的编号
    const code = nextContainerCode(codeSeed);
    codeSeed.push({ code });
    return {
      id: spec.id,
      code,
      shelfTierId: tier?.id ?? null,
      slotNo: placement?.slotNo ?? null,
      items: spec.items,
      usedSizeCm: spec.usedSizeCm,
      status: spec.status,
      lastWriteError: '',
      attempts: 1,
      createdAt: now - day * spec.daysAgo,
      updatedAt: now - day * spec.daysAgo,
    };
  });

  const intakeRows = (
    rows: Array<{ id: string; rubbingId: string | null; collectionNo: string; measured: string; catalog: string; reconciled?: boolean }>,
    status: ShelfIntakeStatus,
    extra?: Partial<ShelfIntake>,
  ): ShelfIntake[] =>
    rows.map((row, index) => ({
      id: row.id,
      collectionNo: row.collectionNo,
      rubbingId: row.rubbingId,
      measuredSize: row.measured,
      catalogSizeAtIntake: row.catalog,
      reconciled: row.reconciled ?? false,
      status,
      containerId: extra?.containerId ?? null,
      batchNo: 'PC-20261006-01',
      attempts: status === 'shelved' ? 1 : 0,
      lastWriteError: '',
      source: 'intake',
      note: '',
      createdAt: now - day * 10 + index,
      updatedAt: now - day * 10 + index,
      ...extra,
    }));

  const shelfIntakes: ShelfIntake[] = [
    ...intakeRows(
      [
        { id: 'in_0101', rubbingId: 'rub_0101', collectionNo: 'TB-0101', measured: '210×88', catalog: '210×88' },
        { id: 'in_0102', rubbingId: 'rub_0102', collectionNo: 'TB-0102', measured: '208×86', catalog: '208×86' },
      ],
      'shelved',
      { containerId: 'box_0001' },
    ),
    ...intakeRows(
      [
        { id: 'in_0201', rubbingId: 'rub_0201', collectionNo: 'TB-0201', measured: '250×196', catalog: '250×196' },
        { id: 'in_0202', rubbingId: 'rub_0202', collectionNo: 'TB-0202', measured: '248×194', catalog: '248×194' },
      ],
      'shelved',
      { containerId: 'box_0002' },
    ),
    ...intakeRows(
      [{ id: 'in_0301', rubbingId: 'rub_0301', collectionNo: 'TB-0301', measured: '260×90', catalog: '260×90' }],
      'shelved',
      { containerId: 'box_0003' },
    ),
    ...intakeRows(
      [{ id: 'in_0302', rubbingId: 'rub_0302', collectionNo: 'TB-0302', measured: '尺寸待补', catalog: '205×87' }],
      'pendingShelf',
      { note: '库房实测尺寸字迹潦草无法辨认，待补量后上架', attempts: 0 },
    ),
    ...intakeRows(
      [{ id: 'in_0999', rubbingId: null, collectionNo: 'TB-0999', measured: '198×96', catalog: '' }],
      'pendingClaim',
      { note: '排架账登记此号，编目台查无对应拓本，等人认领' },
    ),
  ];

  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.shelfTiers, db.containers, db.shelfIntakes],
    async () => {
      await db.steles.bulkPut(steles);
      await db.rubbings.bulkPut(rubbings);
      await db.losses.bulkPut(losses);
      await db.seals.bulkPut(seals);
      await db.compares.bulkPut(compares);
      await db.shelfTiers.bulkPut(seedTiers);
      await db.containers.bulkPut(containers);
      await db.shelfIntakes.bulkPut(shelfIntakes);
    },
  );
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
  /** v3 起追加；旧备份导入时缺省按空集合处理 */
  shelfTiers?: ShelfTier[];
  containers?: Container[];
  shelfIntakes?: ShelfIntake[];
}

export async function exportSnapshot(): Promise<RubbingSnapshot> {
  const [steles, rubbings, losses, seals, compares, shelfTiers, containers, shelfIntakes] = await Promise.all([
    db.steles.toArray(),
    db.rubbings.toArray(),
    db.losses.toArray(),
    db.seals.toArray(),
    db.compares.toArray(),
    db.shelfTiers.toArray(),
    db.containers.toArray(),
    db.shelfIntakes.toArray(),
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
    shelfTiers,
    containers,
    shelfIntakes,
  };
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const snapshot = input as Partial<RubbingSnapshot>;
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`;
  // 五张老表为必备集合；排架三表为 v3 追加，旧备份可缺省
  const keys: Array<keyof RubbingSnapshot> = ['steles', 'rubbings', 'losses', 'seals', 'compares'];
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`;
  }
  return '';
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.shelfTiers, db.containers, db.shelfIntakes],
    async () => {
      await Promise.all([
        db.steles.clear(),
        db.rubbings.clear(),
        db.losses.clear(),
        db.seals.clear(),
        db.compares.clear(),
        db.shelfTiers.clear(),
        db.containers.clear(),
        db.shelfIntakes.clear(),
      ]);
    },
  );
}

export async function importSnapshot(snapshot: RubbingSnapshot): Promise<void> {
  await clearAllTables();
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.shelfTiers, db.containers, db.shelfIntakes],
    async () => {
      await db.steles.bulkPut(snapshot.steles);
      await db.rubbings.bulkPut(snapshot.rubbings);
      await db.losses.bulkPut(snapshot.losses);
      await db.seals.bulkPut(snapshot.seals);
      await db.compares.bulkPut(snapshot.compares);
      await db.shelfTiers.bulkPut(snapshot.shelfTiers ?? []);
      await db.containers.bulkPut(snapshot.containers ?? []);
      await db.shelfIntakes.bulkPut(snapshot.shelfIntakes ?? []);
    },
  );
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [steles, rubbings, losses, seals, compares, shelfTiers, containers, shelfIntakes] = await Promise.all([
    db.steles.count(),
    db.rubbings.count(),
    db.losses.count(),
    db.seals.count(),
    db.compares.count(),
    db.shelfTiers.count(),
    db.containers.count(),
    db.shelfIntakes.count(),
  ]);
  return { steles, rubbings, losses, seals, compares, shelfTiers, containers, shelfIntakes };
}

/** 级联删除碑刻 → 拓本 → 损泐 / 钤印 / 比对 / 排架摘除 */
export async function removeSteleCascade(steleId: string): Promise<void> {
  const rubbingIds = (await db.rubbings.where('steleId').equals(steleId).toArray()).map((row) => row.id);
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.shelfTiers, db.containers, db.shelfIntakes],
    async () => {
      if (rubbingIds.length > 0) {
        await db.losses.where('rubbingId').anyOf(rubbingIds).delete();
        await db.seals.where('rubbingId').anyOf(rubbingIds).delete();
        for (const rubbingId of rubbingIds) {
          await detachRubbingFromShelving(rubbingId);
        }
      }
      await db.rubbings.where('steleId').equals(steleId).delete();
      await db.compares.where('steleId').equals(steleId).delete();
      await db.steles.delete(steleId);
    },
  );
}

/** 级联删除拓本 → 损泐 / 钤印 / 涉及的比对记录；排架账流水改回待认领 */
export async function removeRubbingCascade(rubbingId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.rubbings, db.losses, db.seals, db.compares, db.containers, db.shelfIntakes],
    async () => {
      await db.losses.where('rubbingId').equals(rubbingId).delete();
      await db.seals.where('rubbingId').equals(rubbingId).delete();
      const compares = await db.compares.toArray();
      const affected = compares.filter((row) => row.rubbingIdA === rubbingId || row.rubbingIdB === rubbingId);
      if (affected.length > 0) await db.compares.bulkDelete(affected.map((row) => row.id));
      await detachRubbingFromShelving(rubbingId);
      await db.rubbings.delete(rubbingId);
    },
  );
}

/**
 * 拓本从编目台删除后摘除排架占用：
 * 从装具 items 中移除并重算合计；对应入库流水退回「待认领」，等人重新认领。
 */
async function detachRubbingFromShelving(rubbingId: string): Promise<void> {
  const containers = await db.containers.toArray();
  const touched = containers
    .filter((container) => container.items.some((item) => item.rubbingId === rubbingId))
    .map((container) => {
      const items = container.items.filter((item) => item.rubbingId !== rubbingId);
      return {
        ...container,
        items,
        usedSizeCm: items.reduce((sum, item) => sum + item.lengthCm, 0),
        updatedAt: Date.now(),
      };
    });
  if (touched.length > 0) await db.containers.bulkPut(touched);

  const intakes = await db.shelfIntakes.where('rubbingId').equals(rubbingId).toArray();
  if (intakes.length === 0) return;
  const now = Date.now();
  await db.shelfIntakes.bulkPut(
    intakes.map((intake) =>
      intake.status === 'shelved' || intake.status === 'writeFailed'
        ? {
            ...intake,
            status: 'pendingClaim' as ShelfIntakeStatus,
            rubbingId: null,
            containerId: null,
            attempts: 0,
            lastWriteError: '',
            note: '原认领拓本已从编目台删除，退回待认领',
            updatedAt: now,
          }
        : { ...intake, rubbingId: null, updatedAt: now },
    ),
  );
}

/** 重排某碑刻下拓本的版本序号，保证连续 */
export async function renumberRubbings(steleId: string): Promise<void> {
  const rows = await db.rubbings.where('steleId').equals(steleId).toArray();
  const sorted = [...rows].sort((a, b) => (a.versionNo === b.versionNo ? a.createdAt - b.createdAt : a.versionNo - b.versionNo));
  await db.rubbings.bulkPut(sorted.map((row, index) => ({ ...row, versionNo: index + 1, updatedAt: Date.now() })));
}

/* ------------------------ 库房排架：入库 / 认领 / 重试 ------------------------ */

/** 入库账一行：收藏号 + 库房实测尺寸 */
export interface IntakeLine {
  collectionNo: string;
  measuredSize: string;
}

export interface IntakeBatchResult {
  batchNo: string;
  shelved: number;
  pendingClaim: number;
  pendingShelf: number;
  writeFailed: number;
  duplicate: number;
  /** 以库房实测为准回写编目台尺寸的条数 */
  reconciled: number;
  /** 新写入成功的装具编号 */
  createdContainerCodes: string[];
  /** 写库失败挂起的装具 id */
  failedContainerIds: string[];
}

/**
 * 装具写入器：库房侧「写库」动作。
 * 纯前端无后端，默认直接写 IndexedDB；可注入模拟写入器制造瞬时 / 持续失败。
 * 编目台（rubbings 等表）的写入不走此写入器，装具失败不影响编目台。
 */
export interface ContainerWriter {
  writeContainer: (container: Container) => Promise<void>;
}

export const defaultContainerWriter: ContainerWriter = {
  async writeContainer(container) {
    await db.containers.put(container);
  },
};

/**
 * 模拟库房写入器：本批次第一个装具按开关制造失败。
 * - transientFirst：前 CONTAINER_WRITE_MAX_ATTEMPTS-1 次失败，最后一次成功（演示自动重试）；
 * - persistentFirst：始终失败（演示挂起后到「写库失败」区手动重试这一个装具）。
 */
export function createSimulatedContainerWriter(options: {
  transientFirst?: boolean;
  persistentFirst?: boolean;
}): ContainerWriter {
  const attemptsByCode = new Map<string, number>();
  let firstCode: string | null = null;
  return {
    async writeContainer(container) {
      if (firstCode === null) firstCode = container.code;
      const attempt = (attemptsByCode.get(container.code) ?? 0) + 1;
      attemptsByCode.set(container.code, attempt);
      if (container.code === firstCode) {
        if (options.persistentFirst) {
          throw new Error('模拟库房写库失败：柜位索引卡被占用，写入被拒');
        }
        if (options.transientFirst && attempt < CONTAINER_WRITE_MAX_ATTEMPTS) {
          throw new Error(`模拟瞬时写库失败（第 ${attempt} 次写入被退回）`);
        }
      }
      await db.containers.put(container);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface WriteOutcome {
  ok: boolean;
  attempts: number;
  error: string;
}

/**
 * 写一个装具；失败后只重试这一个装具（最多 CONTAINER_WRITE_MAX_ATTEMPTS 次），
 * 逐次退避。不触碰编目台任何表。
 */
async function writeContainerWithRetry(writer: ContainerWriter, container: Container): Promise<WriteOutcome> {
  let lastError = '';
  for (let attempt = 1; attempt <= CONTAINER_WRITE_MAX_ATTEMPTS; attempt += 1) {
    try {
      await writer.writeContainer({ ...container, attempts: attempt });
      return { ok: true, attempts: attempt, error: '' };
    } catch (err) {
      lastError = err instanceof Error ? err.message : '装具写库失败';
      if (attempt < CONTAINER_WRITE_MAX_ATTEMPTS) {
        await sleep(CONTAINER_RETRY_BASE_DELAY_MS * attempt);
      }
    }
  }
  return { ok: false, attempts: CONTAINER_WRITE_MAX_ATTEMPTS, error: lastError };
}

function compactDate(time: number): string {
  const date = new Date(time);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** 入库批次号：PC-YYYYMMDD-NN，同一天逐批递增 */
export function nextBatchNo(existing: Array<Pick<ShelfIntake, 'batchNo'>>, now: number = Date.now()): string {
  const prefix = `PC-${compactDate(now)}-`;
  const max = existing.reduce((acc, intake) => {
    if (!intake.batchNo.startsWith(prefix)) return acc;
    const seq = Number.parseInt(intake.batchNo.slice(prefix.length), 10);
    return Number.isFinite(seq) ? Math.max(acc, seq) : acc;
  }, 0);
  return `${prefix}${String(max + 1).padStart(2, '0')}`;
}

/** 内部：一行待持久化的流水（含可能的装箱条目） */
interface PreparedIntake {
  row: ShelfIntake;
  entry: ShelfPackEntry | null;
}

interface PersistIntakesResult {
  shelved: number;
  pendingShelf: number;
  writeFailed: number;
  createdContainerCodes: string[];
  failedContainerIds: string[];
  reconciledRubbings: Rubbing[];
}

/**
 * 把一批已认领到拓本的流水顺次装箱并落库：
 * 尺寸合计超限另起装具、柜层槽位定死自动开新层；
 * 每个装具独立写入，失败仅重试该装具，重试仍败则挂起（流水随装具挂起）。
 * 只有装具写库成功的拓本，才以库房实测尺寸回写编目台（拓法、损泐字位不动）；
 * 装具挂起时编目台照旧不动。
 */
async function persistPackedIntakes(
  prepared: PreparedIntake[],
  writer: ContainerWriter,
): Promise<PersistIntakesResult> {
  const result: PersistIntakesResult = {
    shelved: 0,
    pendingShelf: 0,
    writeFailed: 0,
    createdContainerCodes: [],
    failedContainerIds: [],
    reconciledRubbings: [],
  };

  const packable = prepared.filter((item): item is PreparedIntake & { entry: ShelfPackEntry } => item.entry !== null);
  if (packable.length === 0) {
    // 全是待认领 / 重复入库 / 待补量：流水照常落库，不产生任何装具
    await db.shelfIntakes.bulkPut(prepared.map((item) => item.row));
    result.pendingShelf = prepared.filter((item) => item.row.status === 'pendingShelf').length;
    return result;
  }
  const tiers = await db.shelfTiers.toArray();
  const containers = await db.containers.toArray();
  const active = containers.find((container) => container.status === 'open') ?? null;

  // 编目台拓本原表（仅用于装具写成功后以库房实测回写尺寸）
  const rubbings = await db.rubbings.toArray();
  const rubbingById = new Map(rubbings.map((rubbing) => [rubbing.id, rubbing]));
  /** 等待「装具写成功」后才回写编目台的尺寸：rubbingId → 库房实测尺寸 */
  const pendingReconcile = new Map<string, string>();
  packable.forEach(({ row, entry }) => {
    if (row.reconciled && row.rubbingId) pendingReconcile.set(row.rubbingId, entry.sizeCm);
  });

  const packed = packShelfEntries(
    packable.map(({ row, entry }) => ({ ...entry, key: row.id })),
    active,
  );

  // 先给所有新装具预排柜层槽位，缺的柜层一次建好
  const newGroupCount = packed.groups.filter((group) => !group.reuseActive).length;
  const placements = planContainerSlots(tiers, containers, newGroupCount);
  const tiersToCreate = Array.from(
    new Map(
      placements
        .filter((placement) => placement.tierId === null)
        .map((placement) => [
          tierKey(placement.cabinetNo, placement.tierNo),
          {
            id: createId('tier'),
            code: tierCodeOf(placement.cabinetNo, placement.tierNo),
            cabinetNo: placement.cabinetNo,
            tierNo: placement.tierNo,
            slotCapacity: TIER_SLOT_CAPACITY,
          } as ShelfTier,
        ]),
    ).values(),
  );
  if (tiersToCreate.length > 0) await db.shelfTiers.bulkPut(tiersToCreate);
  const allTiers = [...tiers, ...tiersToCreate];

  const codeSeed: Array<Pick<Container, 'code'>> = [...containers];
  let now = Date.now();
  const targets: Array<{ groupIndex: number; container: Container; intakeIds: string[] }> = [];
  let newIndex = 0;
  packed.groups.forEach((group) => {
    const intakeIds = group.entries.map((entry) => entry.key);
    const items = group.entries.map((entry): ContainerItem => ({
      rubbingId: entry.rubbingId,
      sizeCm: entry.sizeCm,
      lengthCm: entry.lengthCm,
    }));
    if (group.reuseActive && active) {
      targets.push({
        groupIndex: -1,
        intakeIds,
        container: {
          ...active,
          items: [...active.items, ...items],
          usedSizeCm: active.usedSizeCm + group.usedSizeCm,
        },
      });
      return;
    }
    const placement = placements[newIndex];
    newIndex += 1;
    if (!placement) return;
    const code = nextContainerCode(codeSeed);
    codeSeed.push({ code });
    const tier = allTiers.find((item) => item.code === tierCodeOf(placement.cabinetNo, placement.tierNo));
    targets.push({
      groupIndex: newIndex - 1,
      intakeIds,
      container: {
        id: createId('box'),
        code,
        shelfTierId: tier?.id ?? null,
        slotNo: placement.slotNo,
        items,
        usedSizeCm: group.usedSizeCm,
        status: 'open',
        lastWriteError: '',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    });
  });

  const rowById = new Map(prepared.map((item) => [item.row.id, item.row]));
  const overflowIds = new Set(packed.overflow.map((entry) => entry.key));

  // 逐装具独立写入 + 限次重试；成败都不影响其他装具与编目台
  for (const target of targets) {
    now = Date.now();
    const outcome = await writeContainerWithRetry(writer, { ...target.container, updatedAt: now });
    if (outcome.ok) {
      result.createdContainerCodes.push(target.container.code);
      result.shelved += target.intakeIds.length;
      // 只有这一个装具写成功，才把其内拓本「以库房实测为准」的尺寸回写编目台
      const successNow = Date.now();
      target.intakeIds.forEach((id) => {
        const row = rowById.get(id);
        if (row) {
          row.status = 'shelved';
          row.containerId = target.container.id;
          row.attempts = outcome.attempts;
          row.lastWriteError = '';
          row.updatedAt = now;
          if (row.reconciled && row.rubbingId) {
            const rubbing = rubbingById.get(row.rubbingId);
            if (rubbing && !result.reconciledRubbings.some((item) => item.id === rubbing.id)) {
              result.reconciledRubbings.push({ ...rubbing, sizeCm: pendingReconcile.get(rubbing.id) ?? row.measuredSize, updatedAt: successNow });
            }
          }
        }
      });
    } else {
      // 重试耗尽：挂起这一个装具（留存柜层槽位与装具号），流水随装具挂起
      const ghost: Container = {
        ...target.container,
        status: 'writeFailed',
        attempts: outcome.attempts,
        lastWriteError: outcome.error,
        updatedAt: now,
      };
      await db.containers.put(ghost);
      result.failedContainerIds.push(ghost.id);
      result.writeFailed += target.intakeIds.length;
      target.intakeIds.forEach((id) => {
        const row = rowById.get(id);
        if (row) {
          row.status = 'writeFailed';
          row.containerId = ghost.id;
          row.attempts = outcome.attempts;
          row.lastWriteError = outcome.error;
          row.updatedAt = now;
        }
      });
    }
  }

  // 单件超规分不上的留待上架
  prepared.forEach((item) => {
    if (overflowIds.has(item.row.id) && item.row.status !== 'writeFailed') {
      item.row.status = 'pendingShelf';
      item.row.note = item.row.note || '单件尺寸超过装具上限，需另配装具后上架';
      item.row.updatedAt = Date.now();
      result.pendingShelf += 1;
    }
  });

  if (result.reconciledRubbings.length > 0) await db.rubbings.bulkPut(result.reconciledRubbings);
  await db.shelfIntakes.bulkPut(prepared.map((item) => item.row));

  return result;
}

function emptyIntakeRow(line: IntakeLine, batchNo: string, source: ShelfIntakeSource): ShelfIntake {
  const now = Date.now();
  return {
    id: createId('in'),
    collectionNo: line.collectionNo.trim(),
    rubbingId: null,
    measuredSize: line.measuredSize.trim(),
    catalogSizeAtIntake: '',
    reconciled: false,
    status: 'pendingClaim',
    containerId: null,
    batchNo,
    attempts: 0,
    lastWriteError: '',
    source,
    note: '',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 库房按排架账逐行入库：
 * 1. 认不出对应拓本的收藏号先单独记账（待认领），不装箱；
 * 2. 已上架收藏号重复入库的记为「重复入库」，不重复装箱；
 * 3. 库房实测尺寸与编目台对不上时以库房量的为准回写尺寸，拓法、损泐字位不动；
 * 4. 尺寸合计超限另起装具，柜层槽位定死；
 * 5. 装具写库失败只重试这一个装具，编目台照旧不动。
 */
export async function processShelfIntake(
  lines: IntakeLine[],
  options: { writer?: ContainerWriter; source?: ShelfIntakeSource } = {},
): Promise<IntakeBatchResult> {
  const writer = options.writer ?? defaultContainerWriter;
  const source = options.source ?? 'intake';
  const batchNo = nextBatchNo(await db.shelfIntakes.toArray());

  const rubbings = await db.rubbings.toArray();
  const rubbingByNo = new Map(rubbings.map((rubbing) => [rubbing.collectionNo.trim(), rubbing]));
  const shelvedNos = new Set(
    (await db.shelfIntakes.where('status').anyOf(['shelved', 'writeFailed']).toArray()).map((row) => row.collectionNo.trim()),
  );

  const prepared: PreparedIntake[] = [];
  const summary: IntakeBatchResult = {
    batchNo,
    shelved: 0,
    pendingClaim: 0,
    pendingShelf: 0,
    writeFailed: 0,
    duplicate: 0,
    reconciled: 0,
    createdContainerCodes: [],
    failedContainerIds: [],
  };

  lines.forEach((line) => {
    const row = emptyIntakeRow(line, batchNo, source);
    const rubbing = rubbingByNo.get(row.collectionNo);

    if (shelvedNos.has(row.collectionNo)) {
      row.status = 'duplicate';
      row.rubbingId = rubbing?.id ?? null;
      row.catalogSizeAtIntake = rubbing?.sizeCm ?? '';
      row.note = '该收藏号已有在架装具，重复入库未装箱';
      summary.duplicate += 1;
      prepared.push({ row, entry: null });
      return;
    }
    if (!rubbing) {
      row.note = '排架账收藏号在编目台查无对应拓本，等人认领';
      summary.pendingClaim += 1;
      // 认不出对应拓本：先单独记着等人认领，不装箱
      prepared.push({ row, entry: null });
      return;
    }
    row.rubbingId = rubbing.id;
    row.catalogSizeAtIntake = rubbing.sizeCm;
    const parsed = parseSizeCm(row.measuredSize);
    if (parsed.longEdge === null) {
      row.status = 'pendingShelf';
      row.note = '库房实测尺寸无法辨认，待补量后上架';
      summary.pendingShelf += 1;
      prepared.push({ row, entry: null });
      return;
    }
    if (row.measuredSize !== rubbing.sizeCm.trim()) {
      // 标记待改记；是否实际回写编目台取决于该装具是否写库成功
      row.reconciled = true;
    }
    prepared.push({
      row,
      entry: { key: row.id, rubbingId: rubbing.id, sizeCm: row.measuredSize, lengthCm: parsed.longEdge },
    });
  });

  const persisted = await persistPackedIntakes(prepared, writer);
  summary.shelved += persisted.shelved;
  summary.pendingShelf += persisted.pendingShelf;
  summary.writeFailed += persisted.writeFailed;
  summary.reconciled += persisted.reconciledRubbings.length;
  summary.createdContainerCodes.push(...persisted.createdContainerCodes);
  summary.failedContainerIds.push(...persisted.failedContainerIds);
  return summary;
}

/**
 * 待认领流水人工认领拓本后装箱（认领时同样以库房实测尺寸为准）。
 */
export async function claimShelfIntake(
  intakeId: string,
  rubbingId: string,
  writer: ContainerWriter = defaultContainerWriter,
): Promise<{ ok: boolean; error: string }> {
  const [row, rubbing] = await Promise.all([db.shelfIntakes.get(intakeId), db.rubbings.get(rubbingId)]);
  if (!row) return { ok: false, error: '入库流水不存在' };
  if (row.status !== 'pendingClaim') return { ok: false, error: '该流水不在待认领状态' };
  if (!rubbing) return { ok: false, error: '编目台查无此拓本' };

  // 目标拓本若已在别的装具里（含写库失败挂起），不允许重复装箱
  const occupied = (await db.shelfIntakes.where('rubbingId').equals(rubbingId).toArray()).find(
    (item) => item.status === 'shelved' || item.status === 'writeFailed',
  );
  if (occupied) {
    return { ok: false, error: `该拓本已在装具（流水批次 ${occupied.batchNo}），不能重复认领装箱` };
  }

  const now = Date.now();
  const parsed = parseSizeCm(row.measuredSize);
  const next: ShelfIntake = {
    ...row,
    rubbingId,
    catalogSizeAtIntake: rubbing.sizeCm,
    reconciled: parsed.longEdge !== null && row.measuredSize.trim() !== rubbing.sizeCm.trim(),
    note: row.note || '人工认领后装箱',
    updatedAt: now,
  };
  if (parsed.longEdge === null) {
    next.status = 'pendingShelf';
    next.note = '认领成功；库房实测尺寸无法辨认，待补量后上架';
    await db.shelfIntakes.put(next);
    return { ok: true, error: '' };
  }
  await persistPackedIntakes(
    [{ row: next, entry: { key: next.id, rubbingId, sizeCm: next.measuredSize, lengthCm: parsed.longEdge } }],
    writer,
  );
  return { ok: true, error: '' };
}

/**
 * 待上架流水补量后重新上架；传入新实测尺寸时先改记再装箱。
 */
export async function shelvePendingIntake(
  intakeId: string,
  measuredSize: string | null,
  writer: ContainerWriter = defaultContainerWriter,
): Promise<{ ok: boolean; error: string }> {
  const row = await db.shelfIntakes.get(intakeId);
  if (!row) return { ok: false, error: '入库流水不存在' };
  if (row.status !== 'pendingShelf') return { ok: false, error: '该流水不在待上架状态' };
  const claimedRubbingId = row.rubbingId;
  if (!claimedRubbingId) return { ok: false, error: '尚未认领拓本，无法上架' };

  const next: ShelfIntake = { ...row, updatedAt: Date.now() };
  if (measuredSize !== null) next.measuredSize = measuredSize.trim();
  const parsed = parseSizeCm(next.measuredSize);
  if (parsed.longEdge === null) return { ok: false, error: '实测尺寸仍无法辨认，需填长边×短边' };

  const rubbing = await db.rubbings.get(claimedRubbingId);
  if (rubbing) {
    next.catalogSizeAtIntake = rubbing.sizeCm;
    next.reconciled = next.measuredSize.trim() !== rubbing.sizeCm.trim();
  }
  next.note = next.note || '补量后重新上架';
  await persistPackedIntakes(
    [
      {
        row: next,
        entry: { key: next.id, rubbingId: claimedRubbingId, sizeCm: next.measuredSize, lengthCm: parsed.longEdge },
      },
    ],
    writer,
  );
  return { ok: true, error: '' };
}

export interface RetryContainerResult {
  ok: boolean;
  error: string;
  attempts: number;
  shelvedIntakeIds: string[];
}

/**
 * 写库失败装具的手动重试：只重写这一个装具，
 * 成功后随挂的流水一并转「已上架」；编目台照旧不动。
 */
export async function retryFailedContainer(
  containerId: string,
  writer: ContainerWriter = defaultContainerWriter,
): Promise<RetryContainerResult> {
  const container = await db.containers.get(containerId);
  if (!container) return { ok: false, error: '装具不存在', attempts: 0, shelvedIntakeIds: [] };
  if (container.status !== 'writeFailed') {
    return { ok: false, error: '该装具不在写库失败状态', attempts: container.attempts, shelvedIntakeIds: [] };
  }

  const outcome = await writeContainerWithRetry(writer, {
    ...container,
    status: 'open',
    lastWriteError: '',
    updatedAt: Date.now(),
  });
  const intakes = await db.shelfIntakes.where('containerId').equals(containerId).toArray();
  if (!outcome.ok) {
    await db.containers.put({ ...container, attempts: outcome.attempts, lastWriteError: outcome.error, updatedAt: Date.now() });
    await db.shelfIntakes.bulkPut(
      intakes.map((row) => ({ ...row, attempts: outcome.attempts, lastWriteError: outcome.error, updatedAt: Date.now() })),
    );
    return { ok: false, error: outcome.error, attempts: outcome.attempts, shelvedIntakeIds: [] };
  }

  const now = Date.now();
  // 重试成功后才补做「以库房实测为准」的尺寸回写（挂起期间编目台一直未动）
  const rubbings = await db.rubbings.toArray();
  const rubbingById = new Map(rubbings.map((rubbing) => [rubbing.id, rubbing]));
  const reconciled: Rubbing[] = [];
  intakes.forEach((intake) => {
    if (!intake.reconciled || !intake.rubbingId) return;
    const rubbing = rubbingById.get(intake.rubbingId);
    if (rubbing && rubbing.sizeCm.trim() !== intake.measuredSize.trim()) {
      reconciled.push({ ...rubbing, sizeCm: intake.measuredSize, updatedAt: now });
    }
  });
  if (reconciled.length > 0) await db.rubbings.bulkPut(reconciled);
  await db.shelfIntakes.bulkPut(
    intakes.map((row) => ({
      ...row,
      status: 'shelved' as ShelfIntakeStatus,
      attempts: outcome.attempts,
      lastWriteError: '',
      updatedAt: now,
    })),
  );
  return { ok: true, error: '', attempts: outcome.attempts, shelvedIntakeIds: intakes.map((row) => row.id) };
}

/** 删除一条入库流水（库房记账笔误等场景）；不动装具与拓本 */
export async function removeShelfIntake(intakeId: string): Promise<void> {
  await db.shelfIntakes.delete(intakeId);
}
