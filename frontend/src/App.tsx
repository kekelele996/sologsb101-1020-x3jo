/**
 * 应用外壳：左侧导航 + 顶部当前碑刻上下文 + 页脚数据说明
 * 首屏初始化 IndexedDB（首次自动播种）并 dispatch(loadAll()) 载入三张表。
 */
import { useEffect } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { App as AntdApp, Badge, Button, Layout, Menu, Space, Tag, Typography } from 'antd';
import {
  AppstoreOutlined,
  BookOutlined,
  DiffOutlined,
  ExportOutlined,
  FileSearchOutlined,
  PrinterOutlined,
} from '@ant-design/icons';
import { ROUTES } from './router';
import { loadAll, useAppDispatch, useAppSelector } from './stores/store';
import { selectSteles } from './stores/steleSlice';
import { selectRubbings } from './stores/rubbingSlice';
import { selectLosses } from './stores/lossSlice';
import { initDatabase } from './utils/db';
import { STELE_FORM_LABEL } from './types/stele';

const { Header, Sider, Content, Footer } = Layout;

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();

  const steles = useAppSelector(selectSteles);
  const rubbings = useAppSelector(selectRubbings);
  const losses = useAppSelector(selectLosses);
  const currentSteleId = useAppSelector((state) => state.stele.currentSteleId);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await initDatabase();
        if (cancelled) return;
        await dispatch(loadAll());
      } catch (error) {
        if (cancelled) return;
        message.error(`本地数据库初始化失败：${error instanceof Error ? error.message : '未知错误'}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dispatch, message]);

  const currentStele = steles.find((stele) => stele.id === currentSteleId) ?? null;
  const selectedKey = location.pathname.startsWith('/rubbings')
    ? ROUTES.rubbings
    : location.pathname.startsWith('/losses')
      ? ROUTES.losses
      : location.pathname.startsWith('/compare')
        ? ROUTES.compare
        : location.pathname.startsWith('/export')
          ? ROUTES.export
          : ROUTES.steles;

  return (
    <Layout style={{ minHeight: '100vh', background: 'transparent' }}>
      <Sider width={230} breakpoint="lg" collapsedWidth={0} style={{ background: '#232a26', borderRight: '3px solid #a33a2c' }}>
        <div style={{ padding: '18px 16px 10px' }}>
          <Typography.Title level={5} style={{ color: '#f0e6cf', margin: 0 }}>
            碑帖拓片编目台
          </Typography.Title>
          <Typography.Text style={{ color: 'rgba(240,230,207,0.62)', fontSize: 12 }}>
            gbrubbing · 编目与版本比对
          </Typography.Text>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          style={{ background: 'transparent' }}
          onClick={({ key }) => navigate(key)}
          items={[
            { key: ROUTES.steles, icon: <AppstoreOutlined />, label: '碑刻台账' },
            { key: ROUTES.rubbings, icon: <PrinterOutlined />, label: '拓本登记' },
            { key: ROUTES.losses, icon: <BookOutlined />, label: '损泐字位' },
            { key: ROUTES.compare, icon: <DiffOutlined />, label: '版本比对' },
            { key: ROUTES.export, icon: <ExportOutlined />, label: '编目卡导出' },
          ]}
        />
        <div style={{ padding: '12px 16px', color: 'rgba(240,230,207,0.6)', fontSize: 12 }}>
          <Space direction="vertical" size={2}>
            <span>
              <FileSearchOutlined /> 碑刻 {steles.length} 处
            </span>
            <span>拓本 {rubbings.length} 份</span>
            <span>损泐字位 {losses.length} 条</span>
          </Space>
        </div>
      </Sider>

      <Layout style={{ background: 'transparent' }}>
        <Header
          style={{
            background: '#fffdf7',
            borderBottom: '1px solid rgba(47,58,52,0.16)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingInline: 20,
          }}
        >
          <Space size={10} wrap>
            <Typography.Text strong>当前碑刻：</Typography.Text>
            {currentStele ? (
              <>
                <Tag color="#2f3a34">{currentStele.title}</Tag>
                <Tag>{STELE_FORM_LABEL[currentStele.form]}</Tag>
                <Tag color="gold">{currentStele.era || '年代待考'}</Tag>
                <Tag>{currentStele.location || '所在地未记'}</Tag>
              </>
            ) : (
              <Tag>未选择碑刻</Tag>
            )}
          </Space>
          <Space>
            <Button size="small" onClick={() => navigate(ROUTES.rubbings)}>
              进入拓本登记
            </Button>
            <Badge count={losses.length} showZero color="#a8623a" title="损泐字位总数" />
          </Space>
        </Header>

        <Content style={{ padding: 20, minHeight: 320 }}>
          <Outlet />
        </Content>

        <Footer style={{ textAlign: 'center', background: 'transparent', color: 'rgba(43,42,38,0.45)' }}>
          数据仅保存在本机浏览器（IndexedDB / localStorage）· <Link to={ROUTES.export}>导出 JSON 备份</Link>
        </Footer>
      </Layout>
    </Layout>
  );
}
