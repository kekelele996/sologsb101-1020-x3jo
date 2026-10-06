/**
 * 路由表（与提示词逐字一致）
 * /steles、/rubbings、/losses、/compare、/export
 * 页面按路由懒加载，构建时自动分包。
 */
import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { Skeleton } from 'antd';
import App from '../App';

const SteleList = lazy(() => import('../pages/SteleList'));
const RubbingList = lazy(() => import('../pages/RubbingList'));
const LossBoard = lazy(() => import('../pages/LossBoard'));
const CompareView = lazy(() => import('../pages/CompareView'));
const ExportView = lazy(() => import('../pages/ExportView'));

export const ROUTES = {
  steles: '/steles',
  rubbings: '/rubbings',
  losses: '/losses',
  compare: '/compare',
  export: '/export',
} as const;

function RouteFallback() {
  return <Skeleton active paragraph={{ rows: 6 }} style={{ background: '#fffdf7', padding: 16, borderRadius: 10 }} />;
}

function withSuspense(node: ReactNode): ReactNode {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>;
}

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to={ROUTES.steles} replace /> },
      { path: 'steles', element: withSuspense(<SteleList />) },
      { path: 'rubbings', element: withSuspense(<RubbingList />) },
      { path: 'losses', element: withSuspense(<LossBoard />) },
      { path: 'compare', element: withSuspense(<CompareView />) },
      { path: 'export', element: withSuspense(<ExportView />) },
      { path: '*', element: <Navigate to={ROUTES.steles} replace /> },
    ],
  },
];

export default appRoutes;
