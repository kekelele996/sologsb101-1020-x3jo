import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import './styles/main.css';
import { appRoutes } from './router';
import { store } from './stores/store';

/** 碑帖主题：石墨青主色 + 拓片米黄底 + 朱印点缀 */
const theme = {
  token: {
    colorPrimary: '#2f3a34',
    colorInfo: '#3f5d6b',
    colorSuccess: '#2f6f4f',
    colorWarning: '#c9963c',
    colorError: '#a33a2c',
    colorTextBase: '#2b2a26',
    borderRadius: 8,
    fontFamily:
      '"Songti SC", "Noto Serif SC", "Source Han Serif SC", "PingFang SC", "Microsoft YaHei", serif',
  },
  components: {
    Layout: { headerBg: '#fffdf7', siderBg: '#232a26' },
    Card: { headerBg: '#faf6ec' },
  },
};

const container = document.getElementById('root');
if (!container) {
  throw new Error('未找到 #root 挂载节点');
}

const router = createBrowserRouter(appRoutes);

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <Provider store={store}>
      <ConfigProvider locale={zhCN} theme={theme}>
        <AntdApp>
          <RouterProvider router={router} />
        </AntdApp>
      </ConfigProvider>
    </Provider>
  </React.StrictMode>,
);
