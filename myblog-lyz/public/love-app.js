(function () {
  const { useEffect, useMemo, useState } = React;
  const html = htm.bind(React.createElement);
  const TZ = "Asia/Shanghai";
  const STORAGE_KEY = "love_memorial_v1";
  const EVENT_TAGS = ["见面", "聊天很多", "吵架", "和好", "礼物", "纪念日", "一起吃饭", "一起散步", "旅行", "平凡但幸福"];

  const config = {
    relationshipStart: chinaMs("2026-02-17 00:00:00"),
    meetupTarget: chinaMs("2026-04-25 00:00:00"),
  };

  function chinaMs(v) {
    const [d, t] = v.split(" ");
    const [y, m, day] = d.split("-").map(Number);
    const [h, min, s] = t.split(":").map(Number);
    return Date.UTC(y, m - 1, day, h - 8, min, s);
  }

  function dayKey(ms = Date.now()) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(ms));
  }

  function parseDayKey(key) {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d, -8, 0, 0);
  }

  function splitDuration(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return { d, h, m, s };
  }

  function getMilestones(startMs, nowMs) {
    const days = Math.floor((nowMs - startMs) / 86400000) + 1;
    const nodes = [30, 60, 90, 100, 180, 365];
    let next = nodes.find((n) => n >= days) || (Math.floor(days / 30) + 1) * 30;
    return { days, next, remain: Math.max(0, next - days) };
  }

  async function api(path, opt) {
    const res = await fetch(path, opt);
    if (!res.ok) throw new Error("api");
    return res.json();
  }

  function LoveApp() {
    const [now, setNow] = useState(Date.now());
    const [records, setRecords] = useState({});
    const [month, setMonth] = useState(() => {
      const d = new Date();
      return { y: d.getFullYear(), m: d.getMonth() };
    });
    const [editing, setEditing] = useState(null);
    const [filter, setFilter] = useState("all");
    const [view, setView] = useState("calendar");

    useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(timer);
    }, []);

    useEffect(() => {
      const local = localStorage.getItem(STORAGE_KEY);
      if (local) {
        try { setRecords(JSON.parse(local).dailyRecords || {}); } catch {}
      }
      api("/api/love-records").then((d) => {
        if (d.dailyRecords) {
          setRecords(d.dailyRecords);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
        }
      }).catch(() => {});
    }, []);

    useEffect(() => {
      const payload = { relationshipStart: "2026-02-17 00:00:00", meetupTarget: "2026-04-25 00:00:00", dailyRecords: records, updatedAt: new Date().toISOString() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      const id = setTimeout(() => { api("/api/love-records", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {}); }, 420);
      return () => clearTimeout(id);
    }, [records]);

    const cDown = splitDuration(config.meetupTarget - now);
    const inLove = splitDuration(now - config.relationshipStart);
    const miles = getMilestones(config.relationshipStart, now);

    const dayList = useMemo(() => {
      const first = new Date(month.y, month.m, 1);
      const offset = (first.getDay() + 6) % 7;
      const total = new Date(month.y, month.m + 1, 0).getDate();
      const list = [];
      for (let i = 0; i < offset; i++) list.push(null);
      for (let d = 1; d <= total; d++) {
        const key = `${month.y}-${String(month.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        list.push(key);
      }
      return list;
    }, [month]);

    const stat = useMemo(() => {
      const keys = Object.keys(records);
      const meeting = keys.filter((k) => (records[k].tags || []).includes("见面")).length;
      const memo = keys.filter((k) => (records[k].tags || []).includes("纪念日")).length;
      const tagCount = {};
      keys.forEach((k) => (records[k].tags || []).forEach((t) => tagCount[t] = (tagCount[t] || 0) + 1));
      const topTag = Object.entries(tagCount).sort((a,b)=>b[1]-a[1])[0]?.[0] || "暂无";
      return { recorded: keys.length, meeting, memo, topTag };
    }, [records]);

    const timeline = Object.entries(records).sort((a, b) => a[0] < b[0] ? 1 : -1)
      .filter(([_, r]) => filter === "all" || (filter === "filled" ? true : (r.tags || []).includes(filter)));

    const isMeetupReached = now >= config.meetupTarget;

    return html`
      <div className="love-app">
        <div className="love-wrap">
          <section className="love-hero">
            <div className="love-title">我们已经一起走过</div>
            <div className="love-sub">把每一天都认真记下来</div>
            <div className="meta">${isMeetupReached ? "今天见面啦" : "距离见面还有"}</div>
            <div className="love-counterRow">
              ${[ [cDown.d, "天"], [cDown.h, "时"], [cDown.m, "分"], [cDown.s, "秒"] ].map(([n,l]) => html`<div className="timeBlock"><div className="timeNum">${isMeetupReached ? 0 : n}</div><div className="timeLabel">${l}</div></div>`)}
            </div>
          </section>

          <section className="love-grid">
            <div className="panel">
              <h3>恋爱时间章节</h3>
              <div className="meta">今天是我们在一起的第 ${miles.days} 天 · 已经 ${inLove.d}天 ${inLove.h}时 ${inLove.m}分 ${inLove.s}秒</div>
              <div className="meta" style=${{marginTop:"6px"}}>距离第 ${miles.next} 天纪念日还有 ${miles.remain} 天</div>
              <div className="mile-list">
                ${[30,60,90,100,180,365].map((m)=>html`<span className=${"mile " + (m===miles.next?"active":"")}>${m}天</span>`)}
              </div>

              <div className="toolbar">
                <button className="btn" onClick=${() => setMonth(({y,m}) => m===0 ? {y:y-1,m:11}:{y,m:m-1})}>上个月</button>
                <button className="btn" onClick=${() => setMonth(({y,m}) => m===11 ? {y:y+1,m:0}:{y,m:m+1})}>下个月</button>
                <button className="btn" onClick=${() => { const d=new Date(); setMonth({y:d.getFullYear(),m:d.getMonth()}); }}>回到本月</button>
                <button className="btn" onClick=${() => setView(view === "calendar" ? "timeline" : "calendar")}>切换到${view === "calendar" ? "时间线" : "月历"}</button>
                <button className="btn" onClick=${() => exportData(records, "json")}>导出 JSON</button>
                <button className="btn" onClick=${() => exportData(records, "txt")}>导出摘要</button>
              </div>

              ${view === "calendar" ? html`<div className="calendar">
                <div className="meta" style=${{marginBottom:"8px"}}>${month.y} 年 ${month.m + 1} 月</div>
                <div className="weekhead">${["一","二","三","四","五","六","日"].map(w=>html`<div>${w}</div>`)}</div>
                <div className="days">
                ${dayList.map((key) => {
                  if (!key) return html`<div className="cell muted"></div>`;
                  const rec = records[key];
                  const special = key === "2026-02-17" || key === "2026-04-25";
                  const isToday = key === dayKey(now);
                  return html`<button className=${"cell " + (special?"special":"") + (isToday?" today":"")} onClick=${() => setEditing({ key, ...(rec || { special:false, tags:[], mood:3, note:"" }) })}><span className="d">${Number(key.slice(-2))}</span>${rec ? html`<span className="dot"></span><span className="tag">${(rec.tags||[])[0] || "已记"}</span>`:""}</button>`;
                })}
                </div>
              </div>` : html`<div className="timeline">${timeline.map(([k,v]) => html`<div className="timeline-item"><div><b>${k}</b> · 心情 ${v.mood || 3}/5</div><div className="meta">${(v.tags||[]).join(" · ") || "无标签"}</div><div>${v.note || "（无备注）"}</div></div>`)}</div>`}
            </div>

            <div className="panel">
              <h3>恋爱档案统计</h3>
              <div className="toolbar" style=${{marginTop:"4px"}}>
                <button className="btn" onClick=${() => setFilter("all")}>全部</button>
                <button className="btn" onClick=${() => setFilter("见面")}>只看见面</button>
                <button className="btn" onClick=${() => setFilter("纪念日")}>只看纪念日</button>
                <button className="btn" onClick=${() => setFilter("filled")}>只看有记录</button>
              </div>
              <div className="stats">
                <div className="stat"><small>记录天数</small><b>${stat.recorded}</b></div>
                <div className="stat"><small>见面次数</small><b>${stat.meeting}</b></div>
                <div className="stat"><small>纪念日记录</small><b>${stat.memo}</b></div>
                <div className="stat"><small>高频标签</small><b>${stat.topTag}</b></div>
              </div>
            </div>
          </section>
        </div>

        <aside className=${"drawer " + (editing ? "open" : "") }>
          ${editing ? html`<>
            <h3 style=${{fontFamily:'Cormorant Garamond, serif'}}>记录 ${editing.key}</h3>
            <label className="meta"><input type="checkbox" checked=${editing.special} onChange=${(e)=>setEditing({...editing, special:e.target.checked})} /> 今天有特别的事</label>
            <div className="tag-grid">${EVENT_TAGS.map(tag => html`<button className=${"chip " + ((editing.tags||[]).includes(tag)?"on":"")} onClick=${() => {
              const next = new Set(editing.tags || []);
              next.has(tag) ? next.delete(tag) : next.add(tag);
              setEditing({ ...editing, tags: Array.from(next) });
            }}>${tag}</button>`)}</div>
            <div className="meta">心情：${editing.mood || 3}/5</div>
            <input className="field" type="range" min="1" max="5" value=${editing.mood || 3} onInput=${(e) => setEditing({ ...editing, mood: Number(e.target.value) })} />
            <textarea value=${editing.note || ""} onInput=${(e) => setEditing({ ...editing, note: e.target.value })} placeholder="写下今天的小事..." />
            <div className="toolbar">
              <button className="btn" onClick=${() => { setRecords({ ...records, [editing.key]: { ...editing, updatedAt: new Date().toISOString() } }); setEditing(null); }}>保存</button>
              <button className="btn" onClick=${() => { const n={...records}; delete n[editing.key]; setRecords(n); setEditing(null); }}>删除</button>
              <button className="btn" onClick=${() => setEditing(null)}>关闭</button>
            </div>
          </>` : ""}
        </aside>
      </div>`;
  }

  function exportData(records, type) {
    const entries = Object.entries(records).sort((a,b)=>a[0]>b[0]?1:-1);
    const text = type === "json"
      ? JSON.stringify({ timezone: TZ, dailyRecords: records }, null, 2)
      : entries.map(([k,v]) => `${k} | mood:${v.mood || 3} | ${(v.tags || []).join(",") || "无标签"}\n${v.note || ""}`).join("\n\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = type === "json" ? "love-records.json" : "love-records.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  let mounted = false;
  window.initLoveMemorial = function () {
    if (mounted) return;
    const root = document.getElementById("love-react-root");
    if (!root) return;
    ReactDOM.createRoot(root).render(html`<${LoveApp} />`);
    mounted = true;
  };
})();
