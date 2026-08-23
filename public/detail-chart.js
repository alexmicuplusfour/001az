// Live price chart — the connector entities' detail renderer (planning/
// lightbox-live-chart-plan.md, slice 3). Registered ahead of the built-ins in
// detail-view.js; matches when the board's face comes from a connector and
// replaces the frozen face picture with a live one: area/candles, a range row,
// crosshair readout — the Google Finance idiom.
//
// The client knows NO provider, tier, or range table: the kind toggle, the
// range row, the highlights and the "isn't available" note are all rendered
// from the response (`kinds`/`ranges`/echoed `range`+`kind`/`unavailable`),
// which is the deployment's PROVEN offer (the server's learned-availability
// model). A learned refusal reshapes these controls on the next fetch — and a
// domain with no chart capability at all answers 404 once, which drops this
// renderer into bare mode: the same static view the image renderer would have
// shown. That 404 IS the client's capability discovery, the feature's own
// refusal-driven model — no producer names or capability flags hardcoded here.
//
// Drawing is TradingView's lightweight-charts (vendored, Apache-2.0), lazy-
// loaded on first mount so non-finance boards never pay for it. Its built-in
// attribution logo stays on (their canonical credit); our footer carries the
// DATA credit the providers' terms ask for.
import { state } from './state.js';
import { fullUrl } from './kinds.js';
import { fmtPercent } from './paged-table.js';

let libPromise = null;
const loadLib = () => (libPromise ??= import("./vendor/lightweight-charts.standalone.production.mjs"));

// Canvas series colors — the face producer's own pair (the CSS states reuse
// modal.css's .cb-up/.cb-down for the same two).
const UP = "#16a34a", DOWN = "#dc2626";
const labelFor = (range) => String(range).toUpperCase();
const kindLabel = (kind) => kind.charAt(0).toUpperCase() + kind.slice(1);
// Face period → first-open range: visual continuity from the card face the
// user just clicked. Anything stale self-corrects via the server clamp + echo.
const FACE_PERIOD_RANGE = { "24h": "1d", "7d": "5d", "30d": "1m", "90d": "6m", "1y": "1y", "5y": "5y" };

// Price precision is data-derived — a sub-cent coin must not render "$0.00".
// One precision feeds the axis (priceFormat + priceFormatter), the header and
// the readout, so all three surfaces agree on the number style.
function precisionFor(maxPrice) {
  if (!Number.isFinite(maxPrice) || maxPrice <= 0 || maxPrice >= 1) return 2;
  return Math.min(8, 2 + Math.ceil(-Math.log10(maxPrice)));
}
const moneyFmt = (precision) =>
  new Intl.NumberFormat(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision });

// The wire's time values → the library's (`d` date strings pass through as
// business days; `t` epoch ms → UTC seconds).
const lwTime = (p) => p.d ?? Math.floor(p.t / 1000);

// A crosshair/series time back to display text via the CURRENT response's
// prebuilt formatter (shape.when) — the library hands back what it was fed: a
// "YYYY-MM-DD" string (or its {year,month,day} form) for daily data, UTC
// seconds for intraday.
function timeText(time, shape) {
  if (shape.daily) {
    const d = typeof time === "object"
      ? `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`
      : String(time);
    return shape.when.format(new Date(`${d}T00:00:00Z`));
  }
  return shape.when.format(new Date(time * 1000));
}

export const chartDetail = {
  name: "chart",
  // Any connector-faced entity's vehicle (its first instance — attached file
  // instances keep their own renderers). Deliberately NOT gated on a face
  // producer name or a capability flag: whether a live chart exists is the
  // server's answer, and its 404 → bare mode is the discovery.
  matches: (inst, entity) =>
    !!entity?.symbol &&
    state.boardMapping?.face?.source === "connector" &&
    inst?.id != null && inst.id === entity.instances?.[0]?.id,

  mount(stage, { inst, entity, root }) {
    // ── skeleton ────────────────────────────────────────────────────────────
    const wrap = document.createElement("div");
    wrap.className = "lb-chart";
    wrap.addEventListener("click", (e) => e.stopPropagation()); // controls must not close

    const head = document.createElement("div");
    head.className = "lb-chart-head";
    const title = document.createElement("div");
    title.className = "lb-chart-title";
    const sym = document.createElement("b");
    sym.textContent = entity.symbol || "";
    const name = document.createElement("span");
    name.textContent = entity.displayLabel || "";
    title.append(sym, name);
    const quote = document.createElement("div");
    quote.className = "lb-chart-quote";
    const price = document.createElement("span");
    price.className = "lb-chart-price";
    const delta = document.createElement("span");
    delta.className = "lb-chart-delta";
    quote.append(price, delta);
    head.append(title, quote);

    const media = document.createElement("div");
    media.className = "lb-chart-media";
    // The canvas is ALWAYS laid out — never display:none. The library measures
    // its container at creation and fitContent computes bar spacing from the
    // chart's width; a chart created (or fitted) inside a hidden 0×0 box keeps
    // that degenerate range when autoSize later inflates it, rendering the
    // series crushed against the right edge on first open. Layering does the
    // swap instead: the static face sits ON TOP (later in the DOM) and hides
    // once the chart has data.
    const canvas = document.createElement("div");
    canvas.className = "lb-chart-canvas";
    media.appendChild(canvas);
    // The static face — the instant fallback every degraded state keeps. A
    // tile vehicle (kind "connector") has no file at all, so no img: a
    // guaranteed 404 is noise, not a fallback.
    let face = null;
    if (inst.kind !== "connector" && inst.name) {
      face = document.createElement("img");
      face.className = "lb-chart-face";
      face.alt = "";
      face.addEventListener("error", () => face.remove()); // regen-deleted file etc.
      face.src = fullUrl(inst.name);
      media.appendChild(face);
    }
    const readout = document.createElement("div");
    readout.className = "lb-chart-readout";
    readout.hidden = true;
    media.appendChild(readout);

    const note = document.createElement("div");
    note.className = "lb-chart-note";
    const controls = document.createElement("div");
    controls.className = "lb-chart-controls";
    const foot = document.createElement("div");
    foot.className = "lb-chart-foot";

    wrap.append(head, media, note, controls, foot);
    stage.appendChild(wrap);

    // ── state ───────────────────────────────────────────────────────────────
    let range = localStorage.getItem("lbChartRange")
      || FACE_PERIOD_RANGE[state.boardMapping?.face?.period] || "1y";
    let kind = localStorage.getItem("lbChartKind") || "area";
    let chart = null;
    let series = null;
    let lib = null;
    let token = 0;
    let aborter = null;
    let unmounted = false;
    // The current response's time shape + prebuilt display formatters + money
    // style — mount-scoped so the crosshair and tick closures (created once, at
    // chart creation) always read the LATEST render's rules. Both stay unset
    // until the first render; nothing that reads them can run before it.
    let shape;
    let money;

    const setNote = (text) => { note.textContent = text || ""; };

    // Bare mode: no live chart for this item (404). With a rendered face the
    // static image is the whole view — exactly today's. A tile vehicle has no
    // file at all, so the empty frame gets a quiet symbol stand-in instead of
    // a blank white box.
    function bare() {
      head.hidden = true;
      controls.hidden = true;
      foot.hidden = true;
      note.hidden = true;
      if (!face || !face.isConnected) {
        const tile = document.createElement("div");
        tile.className = "lb-chart-tile";
        tile.textContent = entity.symbol || "?";
        media.appendChild(tile); // over the (empty) canvas by DOM order
      }
    }

    // ── controls, rebuilt from every response ───────────────────────────────
    const pill = (label, on, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.setAttribute("aria-pressed", String(on)); // the one state channel — CSS styles it
      b.addEventListener("click", onClick);
      return b;
    };

    function renderControls(res) {
      controls.replaceChildren();
      if ((res.kinds || []).length > 1) {
        const seg = document.createElement("div");
        seg.className = "lb-chart-seg";
        for (const k of res.kinds)
          seg.appendChild(pill(kindLabel(k), k === res.kind, () => { if (k !== kind) { kind = k; load(); } }));
        controls.appendChild(seg);
      }
      const row = document.createElement("div");
      row.className = "lb-chart-ranges";
      for (const r of res.ranges || [])
        row.appendChild(pill(labelFor(r), r === res.range, () => { if (r !== range) { range = r; load(); } }));
      controls.appendChild(row);
    }

    // ── the chart itself ────────────────────────────────────────────────────
    function render(res) {
      const daily = res.time === "daily";
      const points = res.points || [];
      if (points.length < 2) {
        // Blank the chart (a STALE range's series behind the note would lie)
        // and put the face back on top when there is one.
        if (series) { chart.removeSeries(series); series = null; }
        if (face) face.hidden = false;
        price.textContent = "";
        delta.textContent = "";
        setNote("No data for this range.");
        return;
      }

      // One pass for the price ceiling (h bounds l, p bounds itself) — the
      // precision every money surface shares this render.
      let maxV = 0;
      if (res.kind === "candles") { for (const p of points) if (p.h > maxV) maxV = p.h; }
      else { for (const p of points) if (p.p > maxV) maxV = p.p; }
      const precision = precisionFor(maxV);
      const fmt = moneyFmt(precision);
      money = (v) => "$" + fmt.format(v);
      // Display formatters, prebuilt once per render (an options-bearing
      // toLocale* call constructs a fresh Intl.DateTimeFormat every time — too
      // hot for the crosshair's mousemove path). Custom tick output exists
      // ONLY for crypto intraday (real epochs → the viewer's clock); the
      // library's UTC defaults are exactly right for exchange-encoded bars and
      // date-string dailies.
      const local = !daily && res.tz === "local";
      shape = {
        daily,
        when: new Intl.DateTimeFormat(undefined, daily
          ? { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }
          : { ...(res.tz === "utc" ? { timeZone: "UTC" } : {}),
              month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }),
        tickTime: local ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }) : null,
        tickDay: local ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }) : null,
      };

      const { createChart, AreaSeries, CandlestickSeries, LineStyle, ColorType } = lib;
      if (!chart) {
        chart = createChart(canvas, {
          autoSize: true,
          layout: {
            background: { type: ColorType.Solid, color: "#ffffff" },
            textColor: "#8a8a96",
            fontFamily: getComputedStyle(document.body).fontFamily,
          },
          grid: { vertLines: { color: "#f0f0f2" }, horzLines: { color: "#f0f0f2" } },
          rightPriceScale: { borderVisible: false },
          timeScale: {
            borderVisible: false,
            secondsVisible: false,
            // One formatter for the chart's whole life, reading the CURRENT
            // response's shape — installed once because applyOptions can't
            // un-set a formatter (its merge skips undefined). Returning null
            // falls back to the library default.
            tickMarkFormatter: (t, type) => {
              if (!shape?.tickTime || typeof t !== "number") return null;
              const d = new Date(t * 1000);
              return type >= 3 ? shape.tickTime.format(d) : shape.tickDay.format(d); // 3 = TickMarkType.Time
            },
          },
          handleScroll: false,
          handleScale: false,
        });
        chart.subscribeCrosshairMove((param) => {
          const data = param.time != null && series ? param.seriesData.get(series) : null;
          if (!data) { readout.hidden = true; return; }
          const when = timeText(param.time, shape);
          readout.textContent = data.value != null
            ? `${when}   ${money(data.value)}`
            : `${when}   O ${money(data.open)}  H ${money(data.high)}  L ${money(data.low)}  C ${money(data.close)}`;
          readout.hidden = false;
        });
      }
      chart.applyOptions({
        timeScale: { timeVisible: !daily },
        localization: { priceFormatter: money },
      });

      // First/last close the whole render works from: line color, header
      // price, range delta. Recreate the series per render — kinds carry
      // different options, and it keeps price-line bookkeeping at zero.
      const first = res.kind === "candles" ? points[0].c : points[0].p;
      const last = res.kind === "candles" ? points[points.length - 1].c : points[points.length - 1].p;
      if (series) chart.removeSeries(series);
      const priceFormat = { type: "price", precision, minMove: 10 ** -precision };
      if (res.kind === "candles") {
        series = chart.addSeries(CandlestickSeries, {
          upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
          borderVisible: false, priceFormat,
        });
        series.setData(points.map((p) => ({ time: lwTime(p), open: p.o, high: p.h, low: p.l, close: p.c })));
      } else {
        const color = last >= first ? UP : DOWN;
        series = chart.addSeries(AreaSeries, {
          lineColor: color, lineWidth: 2,
          topColor: color + "29", bottomColor: color + "00", // 16% → 0, the face gradient
          priceFormat,
        });
        series.setData(points.map((p) => ({ time: lwTime(p), value: p.p })));
      }

      // Prev-close dashed baseline: presence of a change_1d field IS the
      // domain-agnostic signal (a rolling 24h change never qualifies — its
      // baseline is the first point already). 1d only, derived from the
      // entity's own card numbers, never load-bearing.
      const pv = entity.fields?.price?.v, ch = entity.fields?.change_1d?.v;
      if (res.range === "1d" && Number.isFinite(pv) && Number.isFinite(ch) && ch > -100) {
        series.createPriceLine({
          price: pv / (1 + ch / 100),
          color: "#b6b6be", lineWidth: 1, lineStyle: LineStyle.Dashed,
          axisLabelVisible: false, title: "",
        });
      }
      chart.timeScale().fitContent();

      // Header numbers come from the SERIES — entity.fields mutate under the
      // open lightbox on live boards (delta polls), the plotted data doesn't.
      price.textContent = money(last);
      if (Number.isFinite(first) && first !== 0) {
        const pct = ((last - first) / first) * 100;
        delta.textContent = `${fmtPercent(pct)} ${labelFor(res.range)}`;
        delta.className = "lb-chart-delta " + (pct >= 0 ? "cb-up" : "cb-down");
      } else {
        delta.textContent = "";
      }

      readout.hidden = true;
      if (face) face.hidden = true; // reveal the chart beneath
      // The note speaks the response's own vocabulary: a kind-level refusal
      // (the served range survives via its other flavour) names the KIND —
      // naming the range there would contradict the working chart above it.
      const un = res.unavailable;
      setNote(!un ? ""
        : un.range === res.range
          ? `${kindLabel(un.kind)} ${un.kind === "candles" ? "aren't" : "isn't"} available from this data source.`
          : `${labelFor(un.range)} isn't available from this data source.`);
      foot.textContent = res.attribution?.text || "";
    }

    // ── fetch loop ──────────────────────────────────────────────────────────
    async function load() {
      const my = ++token;
      aborter?.abort();
      aborter = new AbortController();
      if (!chart) root.classList.add("loading");
      else media.classList.add("dim");
      setNote("");
      try {
        // Dispatch the fetch, then resolve the (module-memoized) library while
        // it's in flight.
        const fetchP = fetch(
          `/api/items/${entity.id}/chart?range=${encodeURIComponent(range)}&kind=${encodeURIComponent(kind)}`,
          { signal: aborter.signal, cache: "no-store" });
        lib ??= await loadLib();
        const r = await fetchP;
        if (my !== token || unmounted) return;
        if (r.status === 404) { bare(); return; }
        const body = await r.json().catch(() => null);
        if (my !== token || unmounted) return;
        if (!r.ok || !body) {
          setNote(body?.error || "Chart data is unavailable right now.");
          return; // static face stays; any range click retries
        }
        range = body.range; // follow the echo — the server may have clamped
        kind = body.kind;
        try { localStorage.setItem("lbChartRange", range); localStorage.setItem("lbChartKind", kind); } catch { /* private mode */ }
        renderControls(body);
        render(body);
      } catch (e) {
        if (e?.name === "AbortError" || my !== token || unmounted) return;
        setNote("Chart data is unavailable right now.");
      } finally {
        if (my === token) {
          root.classList.remove("loading");
          media.classList.remove("dim");
        }
      }
    }

    load();

    return {
      unmount() {
        unmounted = true;
        aborter?.abort();
        root.classList.remove("loading");
        chart?.remove();
        chart = null;
        wrap.remove();
      },
    };
  },
};
