import { llmsSummary } from "@/lib/marketing/llms";

export const dynamic = "force-static";

/** Generated from the structured content source so it can't drift from the site. */
export function GET() {
  return new Response(llmsSummary(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
