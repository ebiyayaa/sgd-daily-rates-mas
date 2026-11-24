import { getMASRates, MASRatesError } from "../lib/mas-rates.ts";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    const data = await getMASRates(url.searchParams.get("period") ?? "daily", url.searchParams.get("date"));
    return Response.json(data, {
      headers: { "Cache-Control": "public, max-age=60", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    const known = error instanceof MASRatesError;
    return Response.json({
      error: known ? error.message : "MAS rates are temporarily unavailable. Please try again shortly.",
      source: "Monetary Authority of Singapore",
    }, {
      status: known ? error.status : 502,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
}
