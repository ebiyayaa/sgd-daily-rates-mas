export const MAS_SOURCE_URL = "https://eservices.mas.gov.sg/statistics/msb/ExchangeRates.aspx";

export type RatePeriod = "daily" | "monthly";

export interface MASRate {
  currency: string;
  name: string;
  units: 1 | 100;
  sgdPerQuotedUnit: number;
  sgdPerUnit: number;
  publishedValue: string;
}

export interface MASRatesResponse {
  source: { name: string; url: string; attribution: string };
  period: RatePeriod;
  requestedDate: string | null;
  date: string;
  retrievedAt: string;
  rates: MASRate[];
  basis: string;
}

export class MASRatesError extends Error {
  readonly status: 400 | 502;
  constructor(message: string, status: 400 | 502 = 502) {
    super(message);
    this.name = "MASRatesError";
    this.status = status;
  }
}

const CURRENCIES: Record<string, string> = {
  Euro: "EUR", "Pound Sterling": "GBP", "US Dollar": "USD",
  "Australian Dollar": "AUD", "Canadian Dollar": "CAD", "Chinese Renminbi": "CNY",
  "Hong Kong Dollar": "HKD", "Indian Rupee": "INR", "Indonesian Rupiah": "IDR",
  "Japanese Yen": "JPY", "Korean Won": "KRW", "Malaysian Ringgit": "MYR",
  "New Taiwan Dollar": "TWD", "New Zealand Dollar": "NZD", "Philippine Peso": "PHP",
  "Qatar Riyal": "QAR", "Saudi Arabia Riyal": "SAR", "Swiss Franc": "CHF",
  "Thai Baht": "THB", "UAE Dirham": "AED", "Vietnamese Dong": "VND",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { expires: number; data: MASRatesResponse }>();
const pending = new Map<string, Promise<MASRatesResponse>>();

export function singaporeToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function shiftMonth(month: string, offset: number): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 7);
}

export function validateRateQuery(period: string, date: string | null, today = singaporeToday()) {
  if (period !== "daily" && period !== "monthly") {
    throw new MASRatesError("Choose daily or monthly rates.", 400);
  }
  const latestMonth = shiftMonth(today.slice(0, 7), -1);
  if (date !== null) {
    if (period === "daily") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new MASRatesError("Choose a date in YYYY-MM-DD format.", 400);
      const parsed = new Date(`${date}T00:00:00Z`);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        throw new MASRatesError("Choose a valid calendar date.", 400);
      }
      if (date < "1988-01-08" || date > today) {
        throw new MASRatesError("Daily dates must be from 8 January 1988 through today in Singapore.", 400);
      }
    } else {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(date) || date < "1988-01" || date > latestMonth) {
        throw new MASRatesError("Choose a completed month from January 1988 onward.", 400);
      }
    }
  }
  return { period: period as RatePeriod, requestedDate: date, cutoff: date ?? (period === "daily" ? today : latestMonth) };
}

// MAS CSV has a descriptive preamble, inherited year/month cells, and quoted footnotes.
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], value = "", quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && value === "") quoted = true;
    else if (char === ",") { row.push(value); value = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(value); rows.push(row); row = []; value = "";
    } else value += char;
  }
  if (value !== "" || row.length) { row.push(value); rows.push(row); }
  return rows;
}

export function parseMASCSV(text: string, period: RatePeriod): { date: string; rates: MASRate[] }[] {
  const rows = csvRows(text);
  const headerIndex = rows.findIndex((row) => row[0]?.trim() === "End of Period");
  if (headerIndex < 0) {
    if (text.includes("No Results Found")) return [];
    throw new MASRatesError("MAS did not return its expected exchange-rate download. Please try again shortly.");
  }
  const columns: { index: number; currency: string; name: string; units: 1 | 100 }[] = [];
  rows[headerIndex].forEach((cell, index) => {
    const match = cell.trim().match(/^S\$\s+Per\s+(?:(100)\s+)?Units?\s+of\s+(.+)$/i);
    if (!match || !CURRENCIES[match[2]]) return;
    columns.push({ index, currency: CURRENCIES[match[2]], name: match[2], units: match[1] ? 100 : 1 });
  });
  if (!columns.length) throw new MASRatesError("The MAS download format has changed. Rates are temporarily unavailable.");
  const records: { date: string; rates: MASRate[] }[] = [];
  let year = "", month = "";
  for (const row of rows.slice(headerIndex + 1)) {
    if (row.length <= (period === "daily" ? 3 : 2)) continue;
    if (row[0]?.trim()) year = row[0].trim();
    if (row[1]?.trim()) {
      const index = MONTHS.findIndex((m) => m.toLowerCase() === row[1].trim().slice(0, 3).toLowerCase());
      month = index >= 0 ? String(index + 1).padStart(2, "0") : "";
    }
    if (!/^\d{4}$/.test(year) || !month) continue;
    const day = row[2]?.trim();
    if (period === "daily" && !/^\d{1,2}$/.test(day ?? "")) continue;
    const date = `${year}-${month}${period === "daily" ? `-${day.padStart(2, "0")}` : ""}`;
    if (period === "daily") {
      const calendarDate = new Date(`${date}T00:00:00Z`);
      if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== date) continue;
    }
    const rates: MASRate[] = [];
    for (const column of columns) {
      const publishedValue = row[column.index]?.trim() ?? "";
      if (!/^\d+(?:\.\d+)?$/.test(publishedValue)) continue;
      const quoted = Number(publishedValue);
      if (!Number.isFinite(quoted) || quoted <= 0) continue;
      rates.push({ currency: column.currency, name: column.name, units: column.units,
        publishedValue, sgdPerQuotedUnit: quoted, sgdPerUnit: quoted / column.units });
    }
    if (rates.length) records.push({ date, rates });
  }
  return records.sort((a, b) => a.date.localeCompare(b.date));
}

function decodeAttribute(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

function extractTokens(html: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const input of html.matchAll(/<input\b[^>]*>/gi)) {
    const name = input[0].match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1];
    const value = input[0].match(/\bvalue\s*=\s*["']([^"']*)["']/i)?.[1];
    if (name && value !== undefined && /^__(?:VIEWSTATE(?:GENERATOR)?|EVENTVALIDATION)$/.test(name)) {
      tokens[name] = decodeAttribute(value);
    }
  }
  if (!tokens.__VIEWSTATE || !tokens.__EVENTVALIDATION || !tokens.__VIEWSTATEGENERATOR) {
    throw new MASRatesError("MAS is temporarily unable to provide its rate download. Please try again shortly.");
  }
  return tokens;
}

function sessionCookies(headers: Headers): string {
  const withCookies = headers as Headers & { getSetCookie?: () => string[] };
  const raw = typeof withCookies.getSetCookie === "function"
    ? withCookies.getSetCookie()
    : (headers.get("set-cookie") ?? "").split(/,(?=\s*[^;,=\s]+=)/);
  return raw.map((value) => value.split(";", 1)[0].trim()).filter(Boolean).join("; ");
}

async function fetchText(init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(MAS_SOURCE_URL, { ...init, signal: controller.signal, redirect: "follow" });
    if (!response.ok) throw new MASRatesError("MAS could not provide rates right now. Please try again shortly.");
    const text = await response.text();
    return { text, headers: response.headers };
  } catch (error) {
    if (error instanceof MASRatesError) throw error;
    // Diagnostic metadata only: never log request bodies, response bodies, cookies or form tokens.
    const diagnostic = error instanceof Error ? error : new Error("Unknown fetch failure");
    const cause = diagnostic.cause as { name?: string; message?: string; code?: string } | undefined;
    console.error("MAS upstream connection failed", {
      method: init.method ?? "GET",
      name: diagnostic.name,
      message: diagnostic.message,
      causeName: cause?.name,
      causeMessage: cause?.message,
      causeCode: cause?.code,
    });
    throw new MASRatesError("The connection to MAS timed out or is unavailable. Please try again shortly.");
  } finally { clearTimeout(timeout); }
}

async function retrieveRates(query: ReturnType<typeof validateRateQuery>): Promise<MASRatesResponse> {
  const month = query.cutoff.slice(0, 7);
  const startMonth = shiftMonth(month, -1) < "1988-01" ? "1988-01" : shiftMonth(month, -1);
  const page = await fetchText({ headers: { Accept: "text/html" } });
  const form = new URLSearchParams(extractTokens(page.text));
  const prefix = "ctl00$ContentPlaceHolder1$";
  const fields = {
    StartYearDropDownList: startMonth.slice(0, 4), EndYearDropDownList: month.slice(0, 4),
    StartMonthDropDownList: String(Number(startMonth.slice(5))), EndMonthDropDownList: String(Number(month.slice(5))),
    FrequencyDropDownList: query.period === "daily" ? "D" : "M", DownloadButton: "Download",
  };
  for (const [name, value] of Object.entries(fields)) form.set(prefix + name, value);
  for (let i = 0; i < 3; i++) form.set(`${prefix}EndOfPeriodPerUnitCheckBoxList$${i}`, "on");
  for (let i = 0; i < 18; i++) form.set(`${prefix}EndOfPeriodPer100UnitsCheckBoxList$${i}`, "on");
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded", Accept: "text/csv,text/plain;q=0.9", Referer: MAS_SOURCE_URL,
  };
  const cookie = sessionCookies(page.headers);
  if (cookie) headers.Cookie = cookie;
  const download = await fetchText({ method: "POST", headers, body: form.toString() });
  const records = parseMASCSV(download.text, query.period).filter((row) => row.date <= query.cutoff);
  const selected = records[records.length - 1];
  if (!selected) throw new MASRatesError("MAS has no published rates on or before that selection in the available period. Please choose another date.");
  return {
    source: {
      name: "Monetary Authority of Singapore", url: MAS_SOURCE_URL,
      attribution: "Rates disseminated by MAS from Refinitiv with permission, for information. Daily quotations reflect the midpoint of buying and selling interbank rates around midday in Singapore.",
    },
    period: query.period, requestedDate: query.requestedDate, date: selected.date,
    retrievedAt: new Date().toISOString(), rates: selected.rates,
    basis: query.period === "daily" ? "Daily interbank reference, around midday in Singapore" : "Official MAS monthly end-of-period rates",
  };
}

export async function getMASRates(period: string = "daily", date: string | null = null): Promise<MASRatesResponse> {
  const query = validateRateQuery(period, date);
  const key = `${query.period}:${query.requestedDate ?? "latest"}:${query.cutoff}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;
  const existing = pending.get(key);
  if (existing) return existing;
  const operation = retrieveRates(query).then((data) => {
    for (const [k, entry] of cache) if (entry.expires <= Date.now()) cache.delete(k);
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + CACHE_TTL_MS, data });
    return data;
  }).finally(() => pending.delete(key));
  pending.set(key, operation);
  return operation;
}
