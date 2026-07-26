import { llmsFull } from "@/lib/marketing/llms";

export const dynamic = "force-static";

/** The full marketing corpus for LLM ingestion — generated from content source. */
export function GET() {
  return new Response(llmsFull(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
