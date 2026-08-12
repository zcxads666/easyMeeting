import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App.jsx';
import './index.css';

// 错误边界：渲染异常时显示友好提示，避免整棵树卸载导致页面"刷新/白屏"
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center p-8">
          <div className="card p-8 max-w-md text-center">
            <p className="text-4xl mb-3">⚠️</p>
            <h2 className="text-lg font-semibold mb-2">页面出现异常</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-5 break-all">{String(this.state.error)}</p>
            <button
              className="btn-primary"
              onClick={() => {
                this.setState({ error: null });
                window.location.hash = '#/';
              }}
            >
              返回首页
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <App />
      </HashRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
