/*
 * 悠三堂マーケットボード — API Worker
 *
 * public/ の静的サイトを配信し、/api 配下で外部データを取得・整形・キャッシュして返す。
 * ブラウザから直接取りに行けない（CORS・レート制限のある）ソースをここで一本化する。
 *
 *   /api/quotes?symbols=7203.T,USDJPY=X   株価・為替・指数の現在値（Yahoo Finance）
 *   /api/chart?symbol=7203.T&range=10y    価格の時系列（Yahoo Finance）
 *   /api/financials?symbol=7203.T         年次業績 10年+（日本: IR BANK / 米国: SEC EDGAR / 他: Yahoo）
 *   /api/crypto                           仮想通貨の時価総額上位（CoinGecko、円建て）
 *   /api/news?group=jp-econ               ニュース見出し（RSS を統合）
 *   /api/news?q=トヨタ自動車               企業・分野のニュース検索（Google ニュース RSS）
 *
 * データはすべて公開情報のスナップショットであり、投資助言ではない。
 */

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// SEC は連絡先入りの User-Agent を要求する
const SEC_UA = "YusandoMarketBoard/1.0 (isozaki@yusando.com)";

const TTL = {
  quotes: 60,
  chart: 60 * 15,
  financials: 60 * 60 * 12,
  secTickers: 60 * 60 * 24,
  crypto: 60 * 3,
  news: 60 * 10,
};

const FEEDS = {
  "jp-econ": [
    { name: "NHK 経済", url: "https://www3.nhk.or.jp/rss/news/cat5.xml" },
    { name: "Yahoo!ニュース 経済", url: "https://news.yahoo.co.jp/rss/topics/business.xml" },
    { name: "Googleニュース ビジネス", url: "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=ja&gl=JP&ceid=JP:ja" },
  ],
  "jp-politics": [
    { name: "NHK 政治", url: "https://www3.nhk.or.jp/rss/news/cat4.xml" },
    { name: "Yahoo!ニュース 国内", url: "https://news.yahoo.co.jp/rss/topics/domestic.xml" },
    { name: "Googleニュース 政治", url: "https://news.google.com/rss/headlines/section/topic/POLITICS?hl=ja&gl=JP&ceid=JP:ja" },
  ],
  "world-econ": [
    { name: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
    { name: "CNBC", url: "https://www.cnbc.com/id/10001147/device/rss/rss.html" },
    { name: "Bloomberg Markets", url: "https://feeds.bloomberg.com/markets/news.rss" },
    { name: "Reuters", url: "https://news.google.com/rss/search?q=site:reuters.com+(economy+OR+markets+OR+fed+OR+inflation)&hl=en-US&gl=US&ceid=US:en" },
  ],
  "world-politics": [
    { name: "NHK 国際", url: "https://www3.nhk.or.jp/rss/news/cat6.xml" },
    { name: "Yahoo!ニュース 国際", url: "https://news.yahoo.co.jp/rss/topics/world.xml" },
    { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
    { name: "Bloomberg Politics", url: "https://feeds.bloomberg.com/politics/news.rss" },
  ],
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    try {
      return await api(url, ctx);
    } catch (e) {
      return json({ error: "server_error", message: String((e && e.message) || e) }, 500);
    }
  },
};

/* ---------------- routing ---------------- */

async function api(url, ctx) {
  const path = url.pathname.replace(/^\/api/, "");
  const p = url.searchParams;

  if (path === "/quotes") {
    const symbols = uniq((p.get("symbols") || "").split(",").map((s) => s.trim()).filter(Boolean)).slice(0, 80);
    if (!symbols.length) return json({ error: "symbols required" }, 400);
    return cached(ctx, "quotes:" + symbols.join(","), TTL.quotes, () => fetchQuotes(symbols));
  }
  if (path === "/chart") {
    const symbol = (p.get("symbol") || "").trim();
    const range = p.get("range") || "1y";
    if (!symbol) return json({ error: "symbol required" }, 400);
    return cached(ctx, `chart:${symbol}:${range}`, TTL.chart, () => fetchChart(symbol, range));
  }
  if (path === "/financials") {
    const symbol = (p.get("symbol") || "").trim().toUpperCase();
    if (!symbol) return json({ error: "symbol required" }, 400);
    return cached(ctx, "fin:" + symbol, TTL.financials, () => fetchFinancials(symbol, ctx));
  }
  if (path === "/crypto") {
    return cached(ctx, "crypto", TTL.crypto, fetchCrypto);
  }
  if (path === "/news") {
    const q = (p.get("q") || "").trim();
    const group = p.get("group") || "";
    const lang = p.get("lang") === "en" ? "en" : "ja";
    const limit = Math.min(parseInt(p.get("limit") || "30", 10) || 30, 100);
    if (q) return cached(ctx, `news:q:${lang}:${q}`, TTL.news, () => searchNews(q, lang, limit));
    if (!FEEDS[group]) return json({ error: "unknown group", groups: Object.keys(FEEDS) }, 400);
    return cached(ctx, "news:" + group, TTL.news, () => fetchNewsGroup(group, limit));
  }
  if (path === "/health") return json({ ok: true, time: new Date().toISOString() });
  return json({ error: "not_found" }, 404);
}

/* ---------------- cache helper ---------------- */

async function cached(ctx, key, ttl, producer) {
  const cache = caches.default;
  const cacheReq = new Request("https://cache.yusando-news.invalid/" + encodeURIComponent(key));
  const hit = await cache.match(cacheReq);
  if (hit) return hit;
  const data = await producer();
  const res = json(data, 200, {
    "Cache-Control": `public, max-age=${Math.min(ttl, 60)}, s-maxage=${ttl}`,
    "X-Generated-At": new Date().toISOString(),
  });
  ctx.waitUntil(cache.put(cacheReq, res.clone()));
  return res;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", ...headers },
  });
}

async function getText(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "*/*", ...headers }, redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).hostname}`);
  return res.text();
}
async function getJson(url, headers = {}) {
  return JSON.parse(await getText(url, headers));
}
const uniq = (a) => Array.from(new Set(a));

/* ---------------- Yahoo Finance: quotes & charts ---------------- */

async function fetchQuotes(symbols) {
  const out = [];
  for (let i = 0; i < symbols.length; i += 20) {
    const chunk = symbols.slice(i, i + 20);
    const u = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(chunk.join(","))}&range=1d&interval=1d`;
    let data;
    try {
      data = await getJson(u);
    } catch (e) {
      out.push(...chunk.map((s) => ({ symbol: s, error: String(e.message) })));
      continue;
    }
    const results = (data.spark && data.spark.result) || [];
    for (const r of results) {
      const m = r.response && r.response[0] && r.response[0].meta;
      if (!m) { out.push({ symbol: r.symbol, error: "no data" }); continue; }
      const price = m.regularMarketPrice;
      const prev = m.chartPreviousClose ?? m.previousClose;
      out.push({
        symbol: r.symbol,
        name: m.shortName || m.longName || r.symbol,
        longName: m.longName || m.shortName || r.symbol,
        price,
        prevClose: prev,
        change: price != null && prev != null ? price - prev : null,
        changePct: m.regularMarketChangePercent ?? (price != null && prev ? ((price - prev) / prev) * 100 : null),
        currency: m.currency,
        high52: m.fiftyTwoWeekHigh,
        low52: m.fiftyTwoWeekLow,
        type: m.instrumentType,
        exchange: m.exchangeName,
        time: m.regularMarketTime ? m.regularMarketTime * 1000 : null,
      });
    }
    const got = new Set(results.map((r) => r.symbol));
    for (const s of chunk) if (!got.has(s)) out.push({ symbol: s, error: "not found" });
  }
  return { quotes: out, fetchedAt: Date.now() };
}

const RANGE_INTERVAL = { "1d": "5m", "5d": "15m", "1mo": "1d", "3mo": "1d", "6mo": "1d", "1y": "1d", "2y": "1wk", "5y": "1wk", "10y": "1mo", "max": "1mo" };

async function fetchChart(symbol, range) {
  const r = RANGE_INTERVAL[range] ? range : "1y";
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${r}&interval=${RANGE_INTERVAL[r]}`;
  const data = await getJson(u);
  const res = data.chart && data.chart.result && data.chart.result[0];
  if (!res) throw new Error("no chart data");
  const ts = res.timestamp || [];
  const close = (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
  const t = [], c = [];
  for (let i = 0; i < ts.length; i++) {
    if (close[i] == null) continue;
    t.push(ts[i] * 1000);
    c.push(close[i]);
  }
  const m = res.meta || {};
  return { symbol, name: m.shortName || m.longName || symbol, currency: m.currency, range: r, t, c, fetchedAt: Date.now() };
}

/* ---------------- 業績（10年） ---------------- */

async function fetchFinancials(symbol, ctx) {
  // 日本株: 4桁コード + .T
  const jp = symbol.match(/^(\d{4}[A-Z]?)\.T$/);
  if (jp) {
    try {
      return await irbankFinancials(jp[1], symbol);
    } catch (e) {
      const fb = await yahooFinancials(symbol);
      fb.note = `IR BANK が取得できなかったため Yahoo Finance の直近${fb.annual.length}期のみ（${e.message}）`;
      return fb;
    }
  }
  // 米国株: 記号なし（例 NVDA, BRK-B）
  if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol) && !symbol.includes("=") && !symbol.startsWith("^")) {
    try {
      const r = await secFinancials(symbol, ctx);
      if (r) return r;
    } catch (e) {
      const fb = await yahooFinancials(symbol);
      fb.note = `SEC EDGAR が取得できなかったため Yahoo Finance の直近${fb.annual.length}期のみ（${e.message}）`;
      return fb;
    }
  }
  return yahooFinancials(symbol);
}

/* --- IR BANK（日本企業、有価証券報告書ベース、2010年前後から） --- */

async function irbankFinancials(code, symbol) {
  const url = `https://irbank.net/${code}/results`;
  const html = await getText(url, { "Accept-Language": "ja" });
  const nameM = html.match(/<title>\s*\d{4}[A-Z]?\s+([^|<]+?)\s*\|/);
  // 見出しは会計基準で揺れる: 売上高／収益（IFRS）／経常収益（銀行）、営業利益／経常利益、当期純利益／利益（IFRS）
  const revenue = irbankSection(html, "(?:売上高|売上収益|収益|営業収益|経常収益|事業収益|純営業収益|保険料等収入)");
  const opRaw = irbankSection(html, "営業利益");
  const op = Object.keys(opRaw).length ? opRaw : irbankSection(html, "経常利益");
  const net = irbankSection(html, "(?:当期純利益|純利益|当期利益|利益)");
  const eps = irbankSection(html, "EPS");
  const div = irbankSection(html, "一株配当");
  const roe = irbankSection(html, "ROE");
  const eq = irbankSection(html, "(?:株主資本|自己資本)比率");
  const periods = uniq([...Object.keys(revenue), ...Object.keys(op), ...Object.keys(net)]).sort();
  if (!periods.length) throw new Error("業績表が見つからない");
  const pick = (sec, p) => (sec[p] ? sec[p].value : null);
  const isFc = (p) => [revenue, op, net, eps].some((sec) => sec[p] && sec[p].forecast);
  let annual = periods.map((p) => ({
    period: p,
    forecast: isFc(p),
    revenue: pick(revenue, p),
    operatingIncome: pick(op, p),
    netIncome: pick(net, p),
    eps: pick(eps, p),
    dividend: pick(div, p),
    roe: pick(roe, p),
    equityRatio: pick(eq, p),
  }));
  // 決算期変更で同一年に2期ある場合などを含め、実績は直近11期＋予想
  const actual = annual.filter((a) => !a.forecast).slice(-11);
  const fc = annual.filter((a) => a.forecast);
  annual = [...actual, ...fc];
  return {
    symbol,
    name: nameM ? nameM[1].trim() : symbol,
    source: "IR BANK（有価証券報告書）",
    sourceUrl: url,
    currency: "JPY",
    annual,
    quarterly: [],
    fetchedAt: Date.now(),
  };
}

// 見出し <h2>売上高<a …>#1</a></h2> の直後にある <dl class="gdl"> を、年度→値 に変換する
function irbankSection(html, heading) {
  const out = {};
  const headRe = new RegExp(`^${heading}$`);
  const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/g;
  let hm, dlBody = null;
  while ((hm = h2.exec(html))) {
    // 注釈リンク「#1」、補足「（自己資本利益率）」「(IFRS)」、脚注記号を落として見出し本体だけにする
    const text = hm[1].replace(/<[^>]+>/g, "").replace(/\s+/g, "").replace(/（.*?）|\(.*?\)|[*＊※]/g, "").replace(/#\d+/g, "");
    if (!headRe.test(text)) continue;
    const rest = html.slice(hm.index + hm[0].length);
    const dl = rest.match(/^[\s\S]*?<dl class="gdl">([\s\S]*?)<\/dl>/);
    const nextH2 = rest.search(/<h2[^>]*>/);
    // 次の見出しより手前にある dl だけを採用
    if (dl && (nextH2 < 0 || dl[0].length - dl[1].length - '<dl class="gdl"></dl>'.length <= nextH2)) dlBody = dl[1];
    break;
  }
  if (!dlBody) return out;
  const it = /<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g;
  let x;
  while ((x = it.exec(dlBody))) {
    const label = x[1].replace(/<[^>]+>/g, "").replace(/&thinsp;|&nbsp;/g, " ").trim();
    const pm = label.match(/^(\d{4}\/\d{2})\s*(予)?/);
    if (!pm) continue;
    const vm = x[2].match(/class="text">([^<]*)/);
    out[pm[1]] = { value: jpNumber(vm ? vm[1] : ""), forecast: !!pm[2] };
  }
  return out;
}

// "31兆3795億" / "-4610億1100万" / "274.45円" / "8.71%" → 数値
function jpNumber(s) {
  s = (s || "").replace(/[,\s円%]/g, "");
  if (!s || s === "-" || s === "－" || s === "―") return null;
  const neg = /^[-△▲−]/.test(s);
  s = s.replace(/^[-△▲−]/, "");
  const units = { 兆: 1e12, 億: 1e8, 万: 1e4 };
  let total = 0, matched = false;
  const re = /([\d.]+)(兆|億|万)/g;
  let m;
  while ((m = re.exec(s))) { total += parseFloat(m[1]) * units[m[2]]; matched = true; }
  if (!matched) {
    const f = parseFloat(s);
    if (isNaN(f)) return null;
    total = f;
  }
  return neg ? -total : total;
}

/* --- SEC EDGAR（米国上場企業、XBRL companyfacts、10年以上） --- */

let secTickerCache = null; // { ts, map }

async function secTickerMap(ctx) {
  if (secTickerCache && Date.now() - secTickerCache.ts < TTL.secTickers * 1000) return secTickerCache.map;
  const data = await getJson("https://www.sec.gov/files/company_tickers.json", { "User-Agent": SEC_UA });
  const map = {};
  for (const k of Object.keys(data)) {
    const r = data[k];
    map[String(r.ticker).toUpperCase()] = { cik: r.cik_str, name: r.title };
  }
  secTickerCache = { ts: Date.now(), map };
  return map;
}

const SEC_TAGS = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenuesNetOfInterestExpense", "Revenue"],
  operatingIncome: ["OperatingIncomeLoss", "ProfitLossFromOperatingActivities"],
  netIncome: ["NetIncomeLoss", "ProfitLossAttributableToOwnersOfParent", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"],
  eps: ["EarningsPerShareDiluted", "DilutedEarningsLossPerShare", "EarningsPerShareBasic", "BasicEarningsLossPerShare"],
  dividend: ["CommonStockDividendsPerShareDeclared", "CommonStockDividendsPerShareCashPaid", "DividendsRecognisedAsDistributionsToOwnersPerShare"],
};

async function secFinancials(symbol, ctx) {
  const map = await secTickerMap(ctx);
  const ent = map[symbol] || map[symbol.replace("-", ".")] || map[symbol.replace(".", "-")];
  if (!ent) return null;
  const cik = String(ent.cik).padStart(10, "0");
  const data = await getJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { "User-Agent": SEC_UA });
  const facts = { ...((data.facts && data.facts["ifrs-full"]) || {}), ...((data.facts && data.facts["us-gaap"]) || {}) };
  const series = {};
  for (const key of Object.keys(SEC_TAGS)) series[key] = secSeries(facts, SEC_TAGS[key]);
  const annualFrames = uniq([...Object.keys(series.revenue.ann), ...Object.keys(series.netIncome.ann)]).sort();
  const qFrames = uniq([...Object.keys(series.revenue.q), ...Object.keys(series.netIncome.q)]).sort();
  if (!annualFrames.length) return null;
  const annual = annualFrames.slice(-11).map((f) => ({
    period: f.slice(2), // CY2024 → 2024
    forecast: false,
    revenue: series.revenue.ann[f] ?? null,
    operatingIncome: series.operatingIncome.ann[f] ?? null,
    netIncome: series.netIncome.ann[f] ?? null,
    eps: series.eps.ann[f] ?? null,
    dividend: series.dividend.ann[f] ?? null,
  }));
  const quarterly = qFrames.slice(-8).map((f) => ({
    period: f.slice(2, 6) + " " + f.slice(6), // CY2025Q3 → 2025 Q3
    revenue: series.revenue.q[f] ?? null,
    operatingIncome: series.operatingIncome.q[f] ?? null,
    netIncome: series.netIncome.q[f] ?? null,
    eps: series.eps.q[f] ?? null,
  }));
  const unit = Object.keys((facts[SEC_TAGS.revenue.find((t) => facts[t])] || facts[SEC_TAGS.netIncome.find((t) => facts[t])] || { units: { USD: 1 } }).units)[0];
  return {
    symbol,
    name: ent.name,
    source: "SEC EDGAR（XBRL companyfacts）",
    sourceUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K`,
    currency: unit || "USD",
    note: "期は暦年（CY）ベース。決算期が暦年と異なる会社は最も重なる年に割り当て",
    annual,
    quarterly,
    fetchedAt: Date.now(),
  };
}

function secSeries(facts, tags) {
  const ann = {}, q = {};
  for (const tag of tags) {
    const f = facts[tag];
    if (!f || !f.units) continue;
    const unitKeys = Object.keys(f.units);
    const unitKey = unitKeys.find((u) => /^(USD|USD\/shares)$/.test(u)) || unitKeys[0];
    for (const r of f.units[unitKey]) {
      if (!r.frame) continue;
      if (/^CY\d{4}$/.test(r.frame)) { if (ann[r.frame] == null) ann[r.frame] = r.val; }
      else if (/^CY\d{4}Q\d$/.test(r.frame)) { if (q[r.frame] == null) q[r.frame] = r.val; }
    }
  }
  return { ann, q };
}

/* --- Yahoo Finance fundamentals（その他・フォールバック。直近4期程度） --- */

async function yahooFinancials(symbol) {
  const types = [
    "annualTotalRevenue", "annualOperatingIncome", "annualNetIncome", "annualDilutedEPS",
    "quarterlyTotalRevenue", "quarterlyOperatingIncome", "quarterlyNetIncome", "quarterlyDilutedEPS",
  ];
  const now = Math.floor(Date.now() / 1000);
  const u = `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?type=${types.join(",")}&period1=${now - 86400 * 365 * 12}&period2=${now + 86400 * 400}`;
  const data = await getJson(u);
  const results = (data.timeseries && data.timeseries.result) || [];
  const annual = {}, quarterly = {};
  let currency = null;
  for (const r of results) {
    const type = r.meta && r.meta.type && r.meta.type[0];
    if (!type || !r[type]) continue;
    const isQ = type.startsWith("quarterly");
    const key = type.replace(/^(annual|quarterly)/, "");
    const field = { TotalRevenue: "revenue", OperatingIncome: "operatingIncome", NetIncome: "netIncome", DilutedEPS: "eps" }[key];
    for (const row of r[type]) {
      if (!row || !row.asOfDate) continue;
      const bucket = isQ ? quarterly : annual;
      const d = row.asOfDate; // 2025-03-31
      const period = isQ ? `${d.slice(0, 4)}/${d.slice(5, 7)}` : `${d.slice(0, 4)}/${d.slice(5, 7)}`;
      bucket[period] = bucket[period] || { period, forecast: false, revenue: null, operatingIncome: null, netIncome: null, eps: null, dividend: null };
      bucket[period][field] = row.reportedValue ? row.reportedValue.raw : null;
      currency = currency || row.currencyCode;
    }
  }
  return {
    symbol,
    name: symbol,
    source: "Yahoo Finance",
    sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/financials`,
    currency: currency || "USD",
    annual: Object.values(annual).sort((a, b) => a.period.localeCompare(b.period)),
    quarterly: Object.values(quarterly).sort((a, b) => a.period.localeCompare(b.period)).slice(-8),
    fetchedAt: Date.now(),
  };
}

/* ---------------- 仮想通貨（CoinGecko） ---------------- */

async function fetchCrypto() {
  const u = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=jpy&order=market_cap_desc&per_page=12&page=1&sparkline=true&price_change_percentage=24h,7d,30d";
  const data = await getJson(u, { Accept: "application/json" });
  const coins = data.map((c) => {
    const sp = (c.sparkline_in_7d && c.sparkline_in_7d.price) || [];
    const step = Math.max(1, Math.floor(sp.length / 48));
    return {
      id: c.id,
      symbol: String(c.symbol).toUpperCase(),
      name: c.name,
      image: c.image,
      price: c.current_price,
      change24h: c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h,
      change7d: c.price_change_percentage_7d_in_currency,
      change30d: c.price_change_percentage_30d_in_currency,
      marketCap: c.market_cap,
      volume24h: c.total_volume,
      high24h: c.high_24h,
      low24h: c.low_24h,
      spark: sp.filter((_, i) => i % step === 0),
    };
  });
  return { coins, currency: "JPY", fetchedAt: Date.now() };
}

/* ---------------- ニュース（RSS） ---------------- */

async function fetchNewsGroup(group, limit) {
  const feeds = FEEDS[group];
  const settled = await Promise.allSettled(feeds.map((f) => getText(f.url).then((xml) => parseRss(xml, f.name))));
  const items = [];
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else errors.push({ feed: feeds[i].name, error: String(r.reason && r.reason.message) });
  });
  return { group, items: mergeNews(items, limit), errors, fetchedAt: Date.now() };
}

async function searchNews(q, lang, limit) {
  const u = lang === "en"
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`
    : `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ja&gl=JP&ceid=JP:ja`;
  const xml = await getText(u);
  return { q, items: mergeNews(parseRss(xml, "Googleニュース"), limit), fetchedAt: Date.now() };
}

function mergeNews(items, limit) {
  const seen = new Set();
  const out = [];
  items.sort((a, b) => (b.time || 0) - (a.time || 0));
  for (const it of items) {
    const key = it.title.replace(/\s+/g, "").slice(0, 40);
    if (!it.title || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

function parseRss(xml, feedName) {
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    let title = cleanText(tag(b, "title"));
    let link = cleanText(tag(b, "link"));
    if (!link) link = cleanText(tag(b, "guid"));
    if (!link) { const l2 = b.match(/<link[^>]*href="([^"]+)"/); link = l2 ? l2[1] : ""; }
    const dateRaw = tag(b, "pubDate") || tag(b, "dc:date") || tag(b, "published") || tag(b, "updated");
    const time = dateRaw ? Date.parse(dateRaw.trim()) : NaN;
    const source = cleanText(tag(b, "source")) || feedName;
    // Google ニュースの見出しは末尾に " - 媒体名" が付く
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(" - " + source).length);
    const desc = cleanText(tag(b, "description")).slice(0, 200);
    if (!title || !link) continue;
    if (/\/videos?\//.test(link) || /for DATE$/.test(title)) continue; // 動画・テンプレート見出しは除外
    items.push({ title, link, time: isNaN(time) ? null : time, source, feed: feedName, summary: desc });
  }
  return items;
}

function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i");
  const m = block.match(re);
  return m ? m[1].trim() : "";
}

function cleanText(s) {
  if (!s) return "";
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = s.replace(/<[^>]+>/g, " ");
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
