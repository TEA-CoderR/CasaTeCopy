import React, { useState, useEffect } from 'react';
import { X, KeyRound, Cookie, ShieldCheck, CheckCircle2, AlertCircle, Loader2, LogOut, ExternalLink, HelpCircle } from 'lucide-react';
import { MegaCediSessionStatus } from '../types';

interface MegaCediLoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSessionUpdated?: () => void;
}

export const MegaCediLoginModal: React.FC<MegaCediLoginModalProps> = ({
  isOpen,
  onClose,
  onSessionUpdated,
}) => {
  const [activeTab, setActiveTab] = useState<'credentials' | 'cookie'>('credentials');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [temporaryCode, setTemporaryCode] = useState('');
  const [cookieString, setCookieString] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<MegaCediSessionStatus | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  // Fetch current session status on mount or open
  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/megacedi/status');
      const data = await res.json();
      if (data.success) {
        setStatus(data.status);
      }
    } catch {}
  };

  useEffect(() => {
    if (isOpen) {
      fetchStatus();
      setFeedback(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleLoginWithCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setFeedback({ type: 'error', message: '请填写完整的用户名和密码' });
      return;
    }

    setIsLoading(true);
    setFeedback({ type: 'info', message: '正在向 megacedi.com 发起登录验证...' });

    try {
      const res = await fetch('/api/megacedi/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          password: password.trim(),
          temporaryCode: temporaryCode.trim(),
        }),
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: 'success', message: data.message || 'MegaCedi 账号登录成功！已保存认证会话。' });
        await fetchStatus();
        onSessionUpdated?.();
      } else {
        setFeedback({
          type: 'error',
          message: data.error || '登录失败，请检查账号密码或改用 Cookie 模式。',
        });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: '网络错误: ' + err.message });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveCookie = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cookieString.trim()) {
      setFeedback({ type: 'error', message: '请输入 Cookie 字符串' });
      return;
    }

    setIsLoading(true);
    setFeedback({ type: 'info', message: '正在验证 MegaCedi 会话 Cookie 有效性...' });

    try {
      const res = await fetch('/api/megacedi/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cookie: cookieString.trim(),
        }),
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: 'success', message: 'Cookie 验证成功并已保存！' });
        await fetchStatus();
        onSessionUpdated?.();
      } else {
        setFeedback({ type: 'error', message: data.error || 'Cookie 验证未通过，请检查是否完整。' });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: '网络错误: ' + err.message });
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/megacedi/logout', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: 'info', message: '已清除 MegaCedi 登录状态，恢复公开目录模式。' });
        setStatus({ authenticated: false, hasCustomCookie: false });
        onSessionUpdated?.();
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: '操作失败: ' + err.message });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-800 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden relative">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/50">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-white text-base flex items-center gap-2">
                <span>MegaCedi (megacedi.com) 账号与登录授权</span>
              </h3>
              <p className="text-xs text-slate-400">
                配置您的 B2B 批发采购账号，获取独家采购底价与全权商品数据
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Current Status Banner */}
        <div className="px-5 py-3 bg-slate-950/80 border-b border-slate-800/80 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <span className="text-slate-400">当前状态:</span>
            {status?.authenticated ? (
              <span className="flex items-center gap-1.5 font-bold text-emerald-400 bg-emerald-950/80 px-2.5 py-1 rounded-full border border-emerald-800/60 font-mono">
                <CheckCircle2 className="w-3.5 h-3.5" />
                已登录 MegaCedi 账号 {status.username ? `(${status.username})` : ''}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-slate-300 bg-slate-800/80 px-2.5 py-1 rounded-full border border-slate-700/60 font-mono">
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                公开目录模式 (无需登录即可抓取条形码/包装/图片/商品库)
              </span>
            )}
          </div>

          {status?.authenticated && (
            <button
              onClick={handleLogout}
              disabled={isLoading}
              className="text-[11px] text-rose-400 hover:text-rose-300 flex items-center gap-1 hover:underline"
            >
              <LogOut className="w-3 h-3" />
              退出账号
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-800 bg-slate-950/40 text-xs font-medium">
          <button
            type="button"
            onClick={() => {
              setActiveTab('credentials');
              setFeedback(null);
            }}
            className={`flex-1 py-3 px-4 flex items-center justify-center gap-2 transition border-b-2 ${
              activeTab === 'credentials'
                ? 'border-emerald-500 text-emerald-400 font-bold bg-slate-900/60'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <KeyRound className="w-4 h-4" />
            <span>账号密码登录</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('cookie');
              setFeedback(null);
            }}
            className={`flex-1 py-3 px-4 flex items-center justify-center gap-2 transition border-b-2 ${
              activeTab === 'cookie'
                ? 'border-emerald-500 text-emerald-400 font-bold bg-slate-900/60'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Cookie className="w-4 h-4" />
            <span>Cookie 直接导入 (推荐·最稳)</span>
          </button>
        </div>

        {/* Body */}
        <div className="p-5">
          {/* Feedback message */}
          {feedback && (
            <div
              className={`mb-4 p-3 rounded-xl text-xs flex items-start gap-2 border ${
                feedback.type === 'success'
                  ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/60'
                  : feedback.type === 'error'
                  ? 'bg-rose-950/40 text-rose-300 border-rose-800/60'
                  : 'bg-cyan-950/40 text-cyan-300 border-cyan-800/60'
              }`}
            >
              {feedback.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              ) : feedback.type === 'error' ? (
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              ) : (
                <Loader2 className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5 animate-spin" />
              )}
              <span className="leading-relaxed">{feedback.message}</span>
            </div>
          )}

          {activeTab === 'credentials' ? (
            <form onSubmit={handleLoginWithCredentials} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  用户名 / Nome Utente:
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="例如: 您的 MegaCedi 账号用户名"
                  className="w-full bg-slate-950 border border-slate-800 focus:border-emerald-500 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-600 focus:outline-none transition"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  密码 / Password:
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="请输入您的 MegaCedi 登录密码"
                  className="w-full bg-slate-950 border border-slate-800 focus:border-emerald-500 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-600 focus:outline-none transition"
                  required
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-semibold text-slate-300">
                    临时安全码 / Codice di accesso (选填):
                  </label>
                  <span className="text-[10px] text-slate-500">仅当收到邮箱动态验证码时填写</span>
                </div>
                <input
                  type="text"
                  value={temporaryCode}
                  onChange={(e) => setTemporaryCode(e.target.value)}
                  placeholder="留空即直接密码登录，若有临时码请输入"
                  className="w-full bg-slate-950 border border-slate-800 focus:border-emerald-500 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-600 focus:outline-none transition"
                />
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 px-4 rounded-xl shadow-lg shadow-emerald-900/30 flex items-center justify-center gap-2 text-xs transition disabled:opacity-60"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>正在验证登录...</span>
                    </>
                  ) : (
                    <>
                      <KeyRound className="w-4 h-4" />
                      <span>登录并保存 MegaCedi 认证</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleSaveCookie} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  MegaCedi Session Cookie 字符串:
                </label>
                <textarea
                  rows={3}
                  value={cookieString}
                  onChange={(e) => setCookieString(e.target.value)}
                  placeholder="粘贴浏览器的 Cookie 即可，例如: ASP.NET_SessionId=...; .ASPXAUTH=..."
                  className="w-full bg-slate-950 border border-slate-800 focus:border-emerald-500 rounded-xl p-3 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none transition resize-none"
                  required
                />
              </div>

              <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800/80 text-[11px] text-slate-400 space-y-1">
                <p className="font-semibold text-slate-300 flex items-center gap-1">
                  <HelpCircle className="w-3.5 h-3.5 text-emerald-400" />
                  如何获取 MegaCedi 的 Cookie?
                </p>
                <ol className="list-decimal list-inside space-y-0.5 pl-1 text-[11px]">
                  <li>在浏览器打开并登录 megacedi.com</li>
                  <li>按 F12 打开开发者工具，切换到【网络 Network】或【应用 Application】</li>
                  <li>复制请求头中的 <code>Cookie: ...</code> 并直接粘贴至上方文本框</li>
                </ol>
              </div>

              <div className="pt-1">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 px-4 rounded-xl shadow-lg shadow-emerald-900/30 flex items-center justify-center gap-2 text-xs transition disabled:opacity-60"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>正在测试 Cookie...</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4" />
                      <span>验证并保存 Cookie</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {/* Note */}
          <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-start gap-2 text-[11px] text-slate-400">
            <span className="text-emerald-400 font-bold shrink-0">💡 提示:</span>
            <span>
              即使用户未配置 MegaCedi 账号，系统也能以公开商品库模式抓取 megacedi.com 全部 22 个大类（包含 13 位官方 EAN 条形码、高清包装图、箱规净重与库存状态）。登录后将额外解锁批发专属含税底价！
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
