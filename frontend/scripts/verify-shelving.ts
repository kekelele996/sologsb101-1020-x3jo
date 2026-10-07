/* 运行时验证脚本（不进构建）：fake-indexeddb + 真实 db 模块
 * 覆盖：v3 播种 / 入库对账回写 / 超限另起装具 / 槽位定死 /
 *       待认领 / 写库失败只挂单装具 / 重试 / v2→v3 旧拓粗分迁移。
 */
import 'fake-indexeddb/auto';
import { strict as assert } from 'node:assert';
import {
  db,
  initDatabase,
  processShelfIntake,
  resetDatabase,
  retryFailedContainer,
  claimShelfIntake,
  exportSnapshot,
} from '../src/utils/db';
import type { ContainerWriter } from '../src/utils/db';
import { packShelfEntries, parseSizeCm, planContainerSlots, classifySizeBand } from '../src/utils/shelving';
import { CONTAINER_SIZE_LIMIT_CM } from '../src/types/container';
import { TIER_SLOT_CAPACITY } from '../src/types/shelfTier';

let passed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ✓ ${name}`);
  if (extra !== undefined) console.log('      ', JSON.stringify(extra));
}

/* ---------------- 纯函数 ---------------- */
function testPure(): void {
  assert.equal(parseSizeCm('88×210').longEdge, 210);
  assert.equal(parseSizeCm('210x88cm').longEdge, 210);
  assert.equal(parseSizeCm('尺寸待补').longEdge, null);
  ok('尺寸解析取长边且容错 ×/x/cm', true);

  const entries = [400, 300, 250, 100].map((lengthCm, i) => ({
    key: `k${i}`,
    rubbingId: `r${i}`,
    sizeCm: `${lengthCm}×10`,
    lengthCm,
  }));
  // 400+300=700 超 600 另起；250 放进第二箱（300+250=550），100 放不下（650）再起第三箱
  const packed = packShelfEntries(entries, null);
  assert.equal(packed.groups.length, 3);
  assert.equal(packed.groups[0].entries.length, 1);
  assert.equal(packed.groups[1].entries.length, 2);
  assert.equal(packed.groups[2].entries.length, 1);
  assert.ok(packed.groups.every((g) => g.usedSizeCm <= CONTAINER_SIZE_LIMIT_CM));
  ok('尺寸合计超限另起装具（600cm 上限）', true, packed.groups.map((g) => g.usedSizeCm));

  const overflow = packShelfEntries(
    [{ key: 'big', rubbingId: 'big', sizeCm: '601×600', lengthCm: 601 }],
    null,
  );
  assert.equal(overflow.overflow.length, 1);
  ok('单件超规分不上、留待上架', true);

  assert.equal(classifySizeBand(null), null);
  assert.equal(classifySizeBand(100), 'small');
  assert.equal(classifySizeBand(200), 'medium');
  assert.equal(classifySizeBand(500), 'large');
  assert.equal(classifySizeBand(601), null);
  ok('旧藏按尺寸粗分三档、超规分不上', true);
}

/* ---------------- 槽位 ---------------- */
function testSlots(): void {
  const tiers = [
    { id: 't1', code: 'A-1', cabinetNo: 'A', tierNo: 1, slotCapacity: TIER_SLOT_CAPACITY, createdAt: 0, updatedAt: 0 },
  ];
  const containers = Array.from({ length: TIER_SLOT_CAPACITY }, (_, i) => ({
    shelfTierId: 't1',
    slotNo: i + 1,
  }));
  const placed = planContainerSlots(tiers, containers, 3);
  // 第一层满，新装具应排到 A-2 槽 1..3
  assert.deepEqual(
    placed.map((p) => `${p.cabinetNo}-${p.tierNo}#${p.slotNo}`),
    ['A-2#1', 'A-2#2', 'A-2#3'],
  );
  assert.ok(placed.every((p) => p.tierId === null), '新柜层待建');
  ok('每层槽位定死、满层自动开新层', true);

  // 一柜 5 层后进位到 B 柜
  const manyTiers: typeof tiers = [];
  for (let t = 1; t <= 5; t += 1) {
    manyTiers.push({ id: `ta${t}`, code: `A-${t}`, cabinetNo: 'A', tierNo: t, slotCapacity: TIER_SLOT_CAPACITY, createdAt: 0, updatedAt: 0 });
  }
  const manyContainers = manyTiers.flatMap((tier) =>
    Array.from({ length: TIER_SLOT_CAPACITY }, (_, i) => ({ shelfTierId: tier.id, slotNo: i + 1 })),
  );
  const next = planContainerSlots(manyTiers, manyContainers, 1);
  assert.equal(next[0]?.cabinetNo, 'B');
  assert.equal(next[0]?.tierNo, 1);
  ok('同一柜位五层摆满后换下一个柜位', true);
}

/* ---------------- 入库编排 ---------------- */
async function testIntake(): Promise<void> {
  await resetDatabase();

  // 新建一份尚未上架的拓本，编目尺寸 205×87，带一条损泐
  const now0 = Date.now();
  await db.rubbings.put({
    id: 'rub_t1', steleId: 'stele_03', versionNo: 3, method: 'cicada', paperType: '棉连纸', inkTone: 'light',
    sizeCm: '205×87', collectionNo: 'TB-T1', dateGuess: '清初拓', state: 'cataloged', createdAt: now0, updatedAt: now0,
  });
  await db.losses.put({
    id: 'loss_t1', rubbingId: 'rub_t1', lineNo: 2, charNo: 3, type: 'crack', severity: 'medium',
    note: '测试损泐', createdAt: now0, updatedAt: now0,
  });

  // 1) 新收藏号正常入库，且尺寸与编目台不符 → 只回写尺寸，拓法/损泐不动
  const rubBefore = (await db.rubbings.get('rub_t1'))!;
  assert.equal(rubBefore.sizeCm, '205×87');
  const lossBefore = JSON.stringify((await db.losses.where('rubbingId').equals('rub_t1').toArray()).map((l) => l.id));
  let res = await processShelfIntake([{ collectionNo: 'TB-T1', measuredSize: '207×88' }]);
  assert.equal(res.shelved, 1);
  assert.equal(res.reconciled, 1);
  const rubAfter = (await db.rubbings.get('rub_t1'))!;
  assert.equal(rubAfter.sizeCm, '207×88');
  assert.equal(rubAfter.method, rubBefore.method, '拓法不动');
  assert.equal(rubAfter.inkTone, rubBefore.inkTone, '墨色不动');
  const lossAfter = JSON.stringify((await db.losses.where('rubbingId').equals('rub_t1').toArray()).map((l) => l.id));
  assert.equal(lossAfter, lossBefore, '损泐字位不动');
  ok('尺寸以库房实测为准回写；拓法、损泐字位照旧不动', true);

  // 2) 认不出的收藏号 → 待认领，单独记账，不生装具
  res = await processShelfIntake([{ collectionNo: 'TB-7777', measuredSize: '120×60' }]);
  assert.equal(res.pendingClaim, 1);
  assert.equal(res.createdContainerCodes.length, 0);
  const pending = await db.shelfIntakes.where('status').equals('pendingClaim').toArray();
  assert.ok(pending.some((r) => r.collectionNo === 'TB-7777' && r.rubbingId === null));
  ok('认不出的收藏号单独记为待认领、不装箱', true);

  // 3) 重复入库
  res = await processShelfIntake([{ collectionNo: 'TB-T1', measuredSize: '207×88' }]);
  assert.equal(res.duplicate, 1);
  ok('已在架收藏号重复入库记为重复', true);

  // 4) 待认领后人工认领装箱（认领到尚未上架的 rub_0302，尺寸以库房实测为准）
  const claimRow = (await db.shelfIntakes.where('status').equals('pendingClaim').toArray()).find((r) => r.collectionNo === 'TB-7777')!;
  const sizeBeforeClaim = (await db.rubbings.get('rub_0302'))!.sizeCm;
  assert.equal(sizeBeforeClaim, '205×87');
  const claim = await claimShelfIntake(claimRow.id, 'rub_0302');
  assert.ok(claim.ok);
  const claimed = await db.shelfIntakes.get(claimRow.id);
  assert.equal(claimed?.status, 'shelved');
  // 库房实测 120×60 与编目 205×87 不符 → 编目台尺寸已改记
  assert.equal((await db.rubbings.get('rub_0302'))!.sizeCm, '120×60');
  ok('待认领可人工认领后装箱，并以库房实测改记尺寸', true);

  // 5) 查无拓本 → 待认领（即便尺寸也无法辨认，先卡在认领）
  const unclaimed = await processShelfIntake([{ collectionNo: 'TB-8888', measuredSize: '看不清' }]);
  assert.equal(unclaimed.pendingClaim, 1);
  assert.equal(unclaimed.pendingShelf, 0);
  ok('认不出收藏号先单独待认领（优先于尺寸校验）', true);

  const containerCount = await db.containers.count();
  ok(`入库全流程无异常，当前装具 ${containerCount} 个`, true);
}

/* ---------------- 写库失败隔离 ---------------- */
function persistentWriterFor(code: string): ContainerWriter {
  return {
    async writeContainer(container) {
      if (container.code === code) throw new Error('库房索引卡故障（持续）');
      await db.containers.put(container);
    },
  };
}

async function testFailureIsolation(): Promise<void> {
  await resetDatabase();

  // 构造一个未上架临时拓本：350cm 长边。当前在用装具 box_0003 已占 260cm，
  // 260+350=610 超限 → 必另起一个新装具，让该新装具的写库持续失败。
  const now = Date.now();
  await db.rubbings.put({
    id: 'rub_tmp1', steleId: 'stele_03', versionNo: 9, method: 'pat', paperType: '皮纸', inkTone: 'light',
    sizeCm: '350×100', collectionNo: 'TB-TMP1', dateGuess: '', state: 'toCatalog', createdAt: now, updatedAt: now,
  });

  const catalogBefore = JSON.stringify(
    (await db.rubbings.toArray()).map((r) => [r.id, r.sizeCm]),
  );

  const existing = await db.containers.toArray();
  const maxCode = existing
    .map((c) => /装具-(\d+)/.exec(c.code)?.[1] ?? '0')
    .map((s) => Number.parseInt(s, 10))
    .reduce((a, b) => Math.max(a, b), 0);
  const failingCode = `装具-${String(maxCode + 1).padStart(4, '0')}`;

  const r2 = await processShelfIntake([{ collectionNo: 'TB-TMP1', measuredSize: '350×100' }], {
    writer: persistentWriterFor(failingCode),
  });
  assert.equal(r2.writeFailed, 1, '该装具挂起 1 条');
  assert.equal(r2.shelved, 0);
  assert.equal(r2.reconciled, 0, '装具失败则编目台尺寸不改记');

  const failed = await db.containers.filter((c) => c.status === 'writeFailed').toArray();
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.code, failingCode);
  ok('写库失败的装具挂起且保留装具号/槽位', true, { code: failingCode });

  const catalogAfterFail = JSON.stringify(
    (await db.rubbings.toArray()).map((r) => [r.id, r.sizeCm]),
  );
  assert.equal(catalogAfterFail, catalogBefore, '挂起时编目台照旧不动');
  ok('失败后只挂这一个装具，编目台不回滚、不改尺寸', true);

  // 手动重试这一个装具（用默认写入器）→ 成功，流水转已上架
  const retry = await retryFailedContainer(failed[0]!.id);
  assert.ok(retry.ok, JSON.stringify(retry));
  const fixed = await db.containers.get(failed[0]!.id);
  assert.notEqual(fixed?.status, 'writeFailed');
  const intake = await db.shelfIntakes.where('containerId').equals(failed[0]!.id).toArray();
  assert.ok(intake.every((i) => i.status === 'shelved'));
  ok('库房只重试这一个装具，成功后随挂流水转已上架', true);
}

/* ---------------- v2 → v3 迁移：旧拓粗分 ---------------- */
async function testUpgrade(): Promise<void> {
  await db.close();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('gbrubbing');
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => resolve();
  });

  // 用 Dexie 先建一个 v2 结构的库（不含排架三表）
  const Dexie = (await import('dexie')).default;
  const v2 = new Dexie('gbrubbing');
  v2.version(2).stores({
    steles: 'id, title, era, form, location, updatedAt',
    rubbings: 'id, steleId, versionNo, method, inkTone, state, updatedAt',
    losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, updatedAt',
    seals: 'id, rubbingId, sealType, position, updatedAt',
    compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, updatedAt',
  });
  const now = Date.now();
  await v2.table('rubbings').bulkPut([
    // 小 80 + 90、中 180、大 300 + 320（620 超 600 另起一箱）、不可辨认、单件超规
    { id: 'v2_s1', steleId: 's', versionNo: 1, method: 'rub', paperType: '', inkTone: 'thick', sizeCm: '80×40', collectionNo: 'V2-S1', dateGuess: '', state: 'cataloged', createdAt: now, updatedAt: now },
    { id: 'v2_s2', steleId: 's', versionNo: 2, method: 'rub', paperType: '', inkTone: 'thick', sizeCm: '90×40', collectionNo: 'V2-S2', dateGuess: '', state: 'cataloged', createdAt: now, updatedAt: now },
    { id: 'v2_m1', steleId: 's', versionNo: 3, method: 'rub', paperType: '', inkTone: 'thick', sizeCm: '180×80', collectionNo: 'V2-M1', dateGuess: '', state: 'cataloged', createdAt: now, updatedAt: now },
    { id: 'v2_l1', steleId: 's', versionNo: 4, method: 'rub', paperType: '', inkTone: 'thick', sizeCm: '300×90', collectionNo: 'V2-L1', dateGuess: '', state: 'cataloged', createdAt: now, updatedAt: now },
    { id: 'v2_l2', steleId: 's', versionNo: 5, method: 'rub', paperType: '', inkTone: 'thick', sizeCm: '320×90', collectionNo: 'V2-L2', dateGuess: '', state: 'cataloged', createdAt: now, updatedAt: now },
    { id: 'v2_u1', steleId: 's', versionNo: 6, method: 'rub', paperType: '', inkTone: 'thick', sizeCm: '尺寸漫漶', collectionNo: 'V2-U1', dateGuess: '', state: 'cataloged', createdAt: now, updatedAt: now },
    { id: 'v2_o1', steleId: 's', versionNo: 7, method: 'rub', paperType: '', inkTone: 'thick', sizeCm: '601×300', collectionNo: 'V2-O1', dateGuess: '', state: 'cataloged', createdAt: now, updatedAt: now },
  ]);
  v2.close();

  await initDatabase(); // 触发 v2 → v3 升级；steles 为空时 initDatabase 还会补播演示数据
  const snapshot = await exportSnapshot();
  assert.equal(snapshot.schemaVersion, 3);

  const intakes = snapshot.shelfIntakes ?? [];
  // 5 件迁移入箱（legacySplit）+ 补播演示数据的在架件
  const legacyShelved = intakes.filter((i) => i.source === 'legacySplit' && i.status === 'shelved');
  const legacyPending = intakes.filter((i) => i.source === 'legacySplit' && i.status === 'pendingShelf');
  assert.equal(legacyShelved.length, 5, '5 件可粗分的旧拓都入箱');
  assert.equal(legacyPending.length, 2, '不可辨认 + 单件超规留待上架');
  assert.ok(legacyShelved.every((i) => i.source === 'legacySplit'));
  ok('旧拓升级：按尺寸粗分，分不上的留待上架', true, {
    legacyBoxes: (snapshot.containers ?? [])
      .filter((c) => c.id.startsWith('box_legacy'))
      .map((c) => `${c.code}:${c.usedSizeCm}:${c.items.length}件`),
    pending: legacyPending.map((i) => `${i.collectionNo}(${i.note.slice(0, 8)})`),
  });

  // 大档 300+320=620 超 600 → 大档至少 2 箱；连同小 / 中档迁移箱 >= 3
  const legacyBoxes = (snapshot.containers ?? []).filter((c) => c.id.startsWith('box_legacy'));
  assert.ok(legacyBoxes.length >= 3, `应至少 3 个迁移箱，实际 ${legacyBoxes.length}`);
  assert.ok(legacyBoxes.every((c) => c.usedSizeCm <= CONTAINER_SIZE_LIMIT_CM), '迁移装箱也守 600 上限');

  // 柜层 id 与柜层码都不得重复（迁移层与后续播种层同库时也不能重码）
  const allTiers = snapshot.shelfTiers ?? [];
  const tierIds = allTiers.map((t) => t.id);
  const tierCodes = allTiers.map((t) => t.code);
  assert.equal(new Set(tierIds).size, tierIds.length, '柜层 id 唯一');
  assert.equal(new Set(tierCodes).size, tierCodes.length, '柜层码唯一（A-1 不得重复）');
  const tierIdSet = new Set(tierIds);
  assert.ok(
    legacyBoxes.every(
      (c) => c.shelfTierId && tierIdSet.has(c.shelfTierId) && (c.slotNo ?? 0) >= 1 && (c.slotNo ?? 99) <= TIER_SLOT_CAPACITY,
    ),
  );
  // 同一柜层槽位不得被两个装具占用
  const slots = legacyBoxes.map((c) => `${c.shelfTierId}#${c.slotNo}`);
  assert.equal(new Set(slots).size, slots.length, '迁移装具槽位互不冲突');
  ok('迁移装箱按定死槽位落柜层，与播种数据不撞层不撞槽', true, {
    tiers: allTiers.map((t) => `${t.id}=${t.code}`),
    slots,
  });
}

async function main(): Promise<void> {
  console.log('纯函数：');
  testPure();
  console.log('槽位：');
  testSlots();
  await initDatabase();
  console.log('入库编排：');
  await testIntake();
  console.log('失败隔离：');
  await testFailureIsolation();
  console.log('v2→v3 迁移：');
  await testUpgrade();
  console.log(`\n全部 ${passed} 项断言通过`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
