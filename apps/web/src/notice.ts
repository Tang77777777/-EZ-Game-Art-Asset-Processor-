import { useEffect, useState } from "react";

// 全局通知与确认弹窗的统一入口（替代浏览器 alert/confirm）：
// 任意组件调 notify(text) 弹错误/提示条，askConfirm(text) 弹像素风确认框（Promise<boolean>）；
// 渲染由 App 根部的 <AppModals /> 单例完成；历史由右上角「消息历史」查看

export type NoticeKind = "error" | "info";

export interface Notice {
  id: number;
  text: string;
  kind: NoticeKind;
}

/** 已弹出过的通知（含时间戳，供消息历史面板） */
export interface NoticeRecord extends Notice {
  at: number;
}

interface ConfirmReq {
  id: number;
  text: string;
  resolve: (ok: boolean) => void;
}

const HISTORY_MAX = 50;

let seq = 0;
let notices: Notice[] = [];
let history: NoticeRecord[] = [];
/** 用户上次打开历史面板时看到的最大 id；大于此值的算未读 */
let historySeenId = 0;
let confirmReq: ConfirmReq | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function dismissNotice(id: number) {
  notices = notices.filter((n) => n.id !== id);
  emit();
}

/** 弹一条通知（默认 error 样式），4.2s 自动消失，点击立即关闭；同时写入历史 */
export function notify(text: string, kind: NoticeKind = "error") {
  const id = ++seq;
  const item: NoticeRecord = { id, text, kind, at: Date.now() };
  notices = [...notices.slice(-3), item]; // 最多同时 4 条，防刷屏
  history = [...history, item].slice(-HISTORY_MAX);
  emit();
  window.setTimeout(() => dismissNotice(id), 4200);
}

/** 像素风确认框；点蒙层/取消 = false，确定 = true（同时只存在一个） */
export function askConfirm(text: string): Promise<boolean> {
  confirmReq?.resolve(false); // 兜底：前一个没有按钮被点就被顶掉时别悬挂
  return new Promise((resolve) => {
    confirmReq = { id: ++seq, text, resolve };
    emit();
  });
}

export function settleConfirm(ok: boolean) {
  confirmReq?.resolve(ok);
  confirmReq = null;
  emit();
}

export function clearNoticeHistory() {
  history = [];
  historySeenId = seq;
  emit();
}

/** 打开历史面板时调用：把当前历史标为已读 */
export function markNoticeHistorySeen() {
  if (history.length) historySeenId = Math.max(historySeenId, history[history.length - 1]!.id);
  else historySeenId = seq;
  emit();
}

/** 订阅当前通知列表、历史与待确认请求 */
export function useNoticeState(): {
  notices: Notice[];
  history: NoticeRecord[];
  unread: number;
  confirm: ConfirmReq | null;
} {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  const unread = history.reduce((n, h) => n + (h.id > historySeenId ? 1 : 0), 0);
  return { notices, history, unread, confirm: confirmReq };
}
