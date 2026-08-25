// dsh-usage-plugin client half: browser bundle in DSH's __ModuleLoader__ format.
// Registers a sidebar footer action (beside Settings) that opens a modal
// usage panel (shell.overlay) showing balance + today tokens + 30-day trend.
// Data comes from the same-origin routes served by the server half.
window.__ModuleLoader__.load({
  id: "dsh-usage-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    // ---------- css ----------
    const cssId = "dsh-usage-plugin/style";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + cssId + "\"]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-usage-plugin";
      tag.dataset.pluginCss = cssId;
      tag.textContent = [
        ".dshu-trigger{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;justify-content:center;align-items:center;padding:0;display:inline-flex}",
        ".dshu-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
        ".dshu-trigger.dshu-active{color:var(--dsw-alias-state-business-primary)}",
        ".dshu-modal{width:600px;max-width:calc(100vw - 48px)}",
        ".dshu-content{width:auto}",
        ".dshu-balance{font-size:28px;font-weight:700;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}",
        ".dshu-balance small{font-size:13px;color:var(--dsw-alias-label-tertiary);margin-left:4px;font-weight:500}",
        ".dshu-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.7;margin-top:4px;overflow-wrap:anywhere}",
        ".dshu-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}",
        ".dshu-cell{min-width:0;background:var(--dsw-alias-bg-soft);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px}",
        ".dshu-cell .dshu-cell-label{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-bottom:3px}",
        ".dshu-cell .dshu-cell-value{font-size:17px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}",
        ".dshu-chart{width:100%;max-width:100%;height:auto;display:block;margin-top:12px}",
        ".dshu-bar{fill:var(--dsw-alias-state-business-primary, #4176e6);opacity:.85}",
        ".dshu-bar:hover{opacity:1}",
        ".dshu-bar-today{opacity:1}",
        ".dshu-xlabel{fill:var(--dsw-alias-label-caption, #9aa3b2);font-size:11px}",
        ".dshu-xlabel-today{fill:var(--dsw-alias-state-business-primary, #4176e6);font-weight:600}",
        ".dshu-foot{display:flex;align-items:center;justify-content:space-between;margin-top:12px}",
        ".dshu-foot .dshu-meta{color:var(--dsw-alias-label-caption);font-size:11px}",
        ".dshu-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin-top:8px;line-height:1.6}",
        ".dshu-btn{display:inline-flex;align-items:center;gap:5px;background:var(--dsw-alias-state-business-primary);color:#fff;border:none;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer}",
        ".dshu-btn:disabled{opacity:.5;cursor:default}"
      ].join("");
      document.head.appendChild(tag);
    }

    // ---------- shared open state (module-level; trigger + panel in one bundle) ----------
    const listeners = new Set();
    let open = false;
    const emit = () => { for (const fn of listeners) fn(); };
    const useOpen = () => react.useSyncExternalStore(
      (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      () => open
    );
    const toggleOpen = () => { open = !open; emit(); };
    const closePanel = () => { if (open) { open = false; emit(); } };

    // ---------- data ----------
    async function fetchStats() {
      const res = await fetch("/api/dsh-usage-plugin/stats", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "stats failed");
      return j;
    }

    function fmtTokens(n) {
      if (n == null || Number.isNaN(n)) return "--";
      if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
      return String(Math.round(n));
    }

    function fmtMoney(v, cur) {
      if (v == null || Number.isNaN(v)) return "--";
      return (cur === "USD" ? "$" : "¥") + Number(v).toFixed(2);
    }

    function fmtTime(ts) {
      if (!ts) return "--";
      return new Date(ts).toLocaleString("zh-CN", { hour12: false });
    }

    // ---------- trigger: sidebar footer action ----------
    function UsageTrigger({ t }) {
      const isOpen = useOpen();
      return react.createElement(primitives.Tooltip, {
        label: t("trigger.label"),
        side: "right",
        delayMs: 300,
        children: react.createElement("button", {
          type: "button",
          "aria-label": t("trigger.label"),
          className: "dshu-trigger" + (isOpen ? " dshu-active" : ""),
          onClick: toggleOpen,
          children: react.createElement(primitives.IconDataOutline16, { size: 16 }),
        }),
      });
    }

    // ---------- chart ----------
    function BarChart({ days }) {
      const W = 640;
      const H = 150;
      const PAD = 16;
      const max = Math.max(1, ...days.map((d) => d.tokens));
      const bw = W / days.length;
      const bars = days.map((d, i) => {
        const h = (H - PAD) * (d.tokens / max);
        const isToday = i === days.length - 1;
        return react.createElement("rect", {
          key: "b" + i,
          x: (i * bw + bw * 0.16).toFixed(1),
          y: (H - PAD - h).toFixed(1),
          width: Math.max(2, bw * 0.68).toFixed(1),
          height: Math.max(h, d.tokens > 0 ? 1.5 : 0).toFixed(1),
          rx: 2,
          className: "dshu-bar" + (isToday ? " dshu-bar-today" : ""),
          children: react.createElement("title", null, d.date + "  " + fmtTokens(d.tokens) + " tokens" + (d.hasData ? "" : "（无记录）")),
        });
      });
      const labels = days.map((d, i) => {
        const isToday = i === days.length - 1;
        return react.createElement("text", {
          key: "l" + i,
          x: (i * bw + bw / 2).toFixed(1),
          y: H - 4,
          textAnchor: "middle",
          className: "dshu-xlabel" + (isToday ? " dshu-xlabel-today" : ""),
          children: isToday ? "今天" : d.date.slice(5),
        });
      });
      return react.createElement("svg", { viewBox: "0 0 " + W + " " + H, width: "100%", className: "dshu-chart", children: bars.concat(labels) });
    }

    // ---------- panel: shell.overlay modal ----------
    function UsagePanel({ t }) {
      const isOpen = useOpen();
      const [data, setData] = react.useState(null);
      const [error, setError] = react.useState(null);
      const [loading, setLoading] = react.useState(false);
      const [tick, setTick] = react.useState(0);

      react.useEffect(() => {
        if (!isOpen) return;
        let alive = true;
        setLoading(true);
        setError(null);
        fetchStats()
          .then((d) => { if (alive) { setData(d); setLoading(false); } })
          .catch((e) => { if (alive) { setError(String(e.message || e)); setLoading(false); } });
        return () => { alive = false; };
      }, [isOpen, tick]);

      const b = data ? data.balance : null;
      const u = data ? data.usage : null;
      const body = react.createElement("div", null,
        error != null
          ? react.createElement("div", { className: "dshu-error", children: t("error") + "：" + error })
          : loading && !data
            ? react.createElement("div", { className: "dshu-sub", children: t("loading") })
            : [
                react.createElement("div", {
                  key: "bal",
                  className: "dshu-balance",
                  children: [fmtMoney(b && b.total, b && b.currency), b && b.currency ? react.createElement("small", { key: "cur", children: b.currency }) : null],
                }),
                b != null
                  ? react.createElement("div", {
                      key: "sub",
                      className: "dshu-sub",
                      children:
                        (b.is_available === false ? "不可用 · " : "") +
                        "充值 " + fmtMoney(b.topped_up, b.currency) +
                        " · 赠送 " + fmtMoney(b.granted, b.currency),
                    })
                  : null,
                react.createElement("div", { key: "grid", className: "dshu-grid", children: [
                    react.createElement("div", { key: "t", className: "dshu-cell", children: [
                      react.createElement("div", { className: "dshu-cell-label", children: t("today") }),
                      react.createElement("div", { className: "dshu-cell-value", children: fmtTokens(u ? u.today.tokens : 0) + " tokens" }),
                      react.createElement("div", { className: "dshu-sub", children: u ? "输入 " + fmtTokens(u.today.input) + " · 输出 " + fmtTokens(u.today.output) + " · 缓存 " + fmtTokens(u.today.cacheRead) + " · 命中 " + (u.today.cacheHitRate * 100).toFixed(0) + "%" : "" }),
                    ]}),
                    react.createElement("div", { key: "d", className: "dshu-cell", children: [
                      react.createElement("div", { className: "dshu-cell-label", children: t("days7") }),
                      react.createElement("div", { className: "dshu-cell-value", children: fmtTokens(u ? u.totals : 0) + " tokens" }),
                      react.createElement("div", { className: "dshu-sub", children: u ? "日均 " + fmtTokens(u.avgDaily) + " · 缓存命中 " + (u.totalsCacheHitRate * 100).toFixed(0) + "%" : "" }),
                    ]}),
                  ]}),
                u ? react.createElement(BarChart, { key: "chart", days: u.days }) : null,
              ]
      );

      const footer = react.createElement("div", { className: "dshu-foot", children: [
        react.createElement("span", { key: "meta", className: "dshu-meta", children: data ? "更新于 " + fmtTime(data.generatedAt) : "" }),
        react.createElement("button", {
          key: "btn",
          type: "button",
          className: "dshu-btn",
          disabled: loading,
          onClick: () => setTick((x) => x + 1),
          children: [react.createElement(primitives.IconRefreshOutline16, { key: "i", size: 13 }), t("refresh")],
        }),
      ]});

      return react.createElement(primitives.Modal, {
        open: isOpen,
        onClose: closePanel,
        title: t("panel.title"),
        closeLabel: t("panel.close"),
        className: "dshu-modal",
        contentClassName: "dshu-content",
        children: body,
        footer,
      });
    }

    // ---------- locale ----------
    const NS = "dshUsage";
    const zh = {
      "trigger.label": "DeepSeek 用量",
      "panel.title": "DeepSeek 用量",
      "panel.close": "关闭",
      "today": "今日用量",
      "days7": "近 7 天",
      "refresh": "刷新",
      "loading": "加载中…",
      "error": "加载失败",
      "noData": "暂无数据",
    };
    const en = {
      "trigger.label": "DeepSeek Usage",
      "panel.title": "DeepSeek Usage",
      "panel.close": "Close",
      "today": "Today",
      "days7": "Last 7 days",
      "refresh": "Refresh",
      "loading": "Loading…",
      "error": "Load failed",
      "noData": "No data",
    };

    // ---------- plugin body ----------
    const inject = ["slots", "locale"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-usage-plugin: dictionaries");
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "dsh-usage-plugin",
        order: 95,
        locale: NS,
      }, UsageTrigger));
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "dsh-usage-plugin-panel",
        locale: NS,
      }, UsagePanel));
    }

    exports.UsageTrigger = UsageTrigger;
    exports.UsagePanel = UsagePanel;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
