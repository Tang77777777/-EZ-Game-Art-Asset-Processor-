import { createRoot } from "react-dom/client";
import App from "./App";
import { initThemeSync } from "./theme";
import { initLangSync } from "./i18n";

// 首屏主题/语言已由 index.html 内联脚本（localStorage）确定；这里拉服务端权威值覆盖
initThemeSync();
initLangSync();

createRoot(document.getElementById("root")!).render(<App />);
