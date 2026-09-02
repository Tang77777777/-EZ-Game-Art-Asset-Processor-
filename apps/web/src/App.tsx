import { lazy, Suspense, useEffect, useState } from "react";
import { MotionConfig } from "motion/react";
import MaterialsPage from "./components/MaterialsPage";
import SettingsPage from "./components/SettingsPage";
import TopNav from "./components/TopNav";
import AppModals from "./components/AppModals";
import JobPanel from "./components/JobPanel";
import { MaterialEditorProvider } from "./components/MaterialEditor";
import { wsClient } from "./api";
import { useT } from "./i18n";

const PipelinePage = lazy(() => import("./components/PipelinePage"));

/**
 * 一级页面。
 *
 * 本产品是「一次性素材加工器」：进素材 → 抽帧 → 处理 → 导出图集。
 * 加工流水线就是首页，所以 `/` 直接渲染它。
 */
type View = { page: "pipeline" } | { page: "materials" } | { page: "settings" };

type Page = View["page"];

/** 一级页面与路径的单一映射源；新增页面只改这里和 viewFromLocation。 */
const PAGE_PATHS = {
  pipeline: "/",
  materials: "/materials",
  settings: "/settings",
} as const;

function viewFromLocation(): View {
  if (/^\/materials/.test(location.pathname)) return { page: "materials" };
  if (/^\/settings/.test(location.pathname)) return { page: "settings" };
  return { page: "pipeline" };
}

export default function App() {
  const t = useT();
  const [view, setView] = useState<View>(viewFromLocation);

  useEffect(() => {
    wsClient.start();
  }, []);

  // 全局屏蔽浏览器原生右键菜单（自定义右键菜单场景；输入框/文本域保留原生菜单用于粘贴等）
  useEffect(() => {
    const suppress = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", suppress);
    return () => window.removeEventListener("contextmenu", suppress);
  }, []);

  // 支持浏览器前进/后退
  useEffect(() => {
    const onPop = () => setView(viewFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const nav = (v: View) => {
    setView(v);
    history.pushState(null, "", PAGE_PATHS[v.page]);
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className={`app-shell app-shell--${view.page === "pipeline" ? "pipeline" : "utility"}`}>
        <MaterialEditorProvider>
          <TopNav current={view.page} onNav={(page: Page) => nav({ page } as View)} />
          {view.page === "pipeline" && (
            <Suspense fallback={<div className="page-loading">{t("pipeline.loading")}</div>}>
              <PipelinePage />
            </Suspense>
          )}
          {view.page === "materials" && <MaterialsPage />}
          {view.page === "settings" && <SettingsPage />}
          {/* 右侧常驻任务队列面板（有任务时才显示） */}
          <JobPanel syncOnEnter={view.page === "materials"} />
          {/* 全局通知条 + 确认弹窗（notice.ts） */}
          <AppModals />
        </MaterialEditorProvider>
      </div>
    </MotionConfig>
  );
}
