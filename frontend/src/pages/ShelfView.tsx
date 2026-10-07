/**
 * /shelving 库房排架台
 * 库房排架账接入编目台：
 * - 按排架账逐行入库，实测尺寸装箱（装具尺寸合计上限、柜层槽位定死）；
 * - 尺寸对不上以库房实测为准（拓法、损泐字位不动）；
 * - 认不出的收藏号单独记着等人认领；
 * - 写库失败只重试这一个装具，编目台照旧不动；
 * - 旧藏升级按尺寸粗分、分不上留待上架（见 IndexedDB v2→v3 迁移）。
 * 消费 ShelfTier / Container / ShelfIntake 与 Rubbing；复用 StatBadge、EmptyPanel 系列组件。
 */
import { useMemo } from 'react';
import { Alert, Card, Col, Row, Tabs, Typography } from 'antd';
import { AppstoreOutlined, InboxOutlined, WarningOutlined } from '@ant-design/icons';
import StatBadge from '@/components/common/StatBadge';
import IntakeForm from '@/components/shelf/IntakeForm';
import PendingClaimTable from '@/components/shelf/PendingClaimTable';
import PendingShelfTable from '@/components/shelf/PendingShelfTable';
import WriteFailedPanel from '@/components/shelf/WriteFailedPanel';
import ShelfBoard from '@/components/shelf/ShelfBoard';
import IntakeLedger from '@/components/shelf/IntakeLedger';
import {
  selectContainers,
  selectFailedContainers,
  selectShelfIntakes,
  selectShelfTiers,
} from '@/stores/shelfSlice';
import { useAppSelector } from '@/stores/store';
import { CONTAINER_SIZE_LIMIT_CM, CONTAINER_WRITE_MAX_ATTEMPTS } from '@/types/container';
import { TIER_SLOT_CAPACITY } from '@/types/shelfTier';

export default function ShelfView() {
  const tiers = useAppSelector(selectShelfTiers);
  const containers = useAppSelector(selectContainers);
  const intakes = useAppSelector(selectShelfIntakes);
  const failedContainers = useAppSelector(selectFailedContainers);

  const stat = useMemo(() => {
    const pendingClaim = intakes.filter((row) => row.status === 'pendingClaim').length;
    const pendingShelf = intakes.filter((row) => row.status === 'pendingShelf').length;
    const writeFailed = intakes.filter((row) => row.status === 'writeFailed').length;
    const reconciled = intakes.filter((row) => row.reconciled).length;
    const shelved = intakes.filter((row) => row.status === 'shelved').length;
    return { pendingClaim, pendingShelf, writeFailed, reconciled, shelved };
  }, [intakes]);

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>库房排架台</h2>
          <p>
            装具尺寸合计上限 {CONTAINER_SIZE_LIMIT_CM}cm · 柜位每层 {TIER_SLOT_CAPACITY} 个装具槽位 ·
            写库失败仅重试该装具（最多 {CONTAINER_WRITE_MAX_ATTEMPTS} 次），编目台数据不回滚
          </p>
        </div>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="柜层" value={tiers.length} suffix="层" tone="primary" icon={<AppstoreOutlined />} />
        <StatBadge label="装具" value={containers.length} suffix="个" tone="info" />
        <StatBadge label="已上架流水" value={stat.shelved} suffix="条" tone="success" />
        <StatBadge label="待认领" value={stat.pendingClaim} suffix="条" tone="warning" icon={<InboxOutlined />} />
        <StatBadge label="待上架" value={stat.pendingShelf} suffix="条" tone="info" />
        <StatBadge label="写库失败" value={stat.writeFailed} suffix="条" tone="danger" icon={<WarningOutlined />} />
        <StatBadge label="以库房为准改记" value={stat.reconciled} suffix="条" />
      </div>

      {failedContainers.length > 0 ? (
        <Alert
          style={{ marginBottom: 16 }}
          type="error"
          showIcon
          message={`有 ${failedContainers.length} 个装具写库失败挂起`}
          description="装具号与柜层槽位已保留，编目台照旧不动。请到「写库失败」页签让库房只重试这一个装具。"
        />
      ) : null}

      <Tabs
        defaultActiveKey="board"
        items={[
          {
            key: 'board',
            label: `柜位平面（${containers.length}）`,
            children: (
              <Card>
                <ShelfBoard />
              </Card>
            ),
          },
          {
            key: 'intake',
            label: '入库排架',
            children: (
              <Row gutter={16}>
                <Col xs={24} xl={11}>
                  <Card title="排架账入库">
                    <IntakeForm />
                  </Card>
                </Col>
                <Col xs={24} xl={13}>
                  <Card title="待认领收藏号" style={{ marginBottom: 16 }}>
                    <PendingClaimTable />
                  </Card>
                  <Card title="待上架（分不上 / 待补量）">
                    <PendingShelfTable />
                  </Card>
                </Col>
              </Row>
            ),
          },
          {
            key: 'failed',
            label: `写库失败（${failedContainers.length}）`,
            children: (
              <Card>
                <WriteFailedPanel />
              </Card>
            ),
          },
          {
            key: 'ledger',
            label: `入库流水（${intakes.length}）`,
            children: (
              <Card>
                <IntakeLedger />
              </Card>
            ),
          },
        ]}
      />

      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
        尺寸以库房实测为唯一准绳：入库 / 认领 / 补量时若与编目员登记尺寸不一致，只回写拓本尺寸；编目员填的拓法、损泐字位与断代结论一概不动。
      </Typography.Paragraph>
    </div>
  );
}
