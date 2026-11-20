import { obsoletePage } from "../../_lib/obsolete.js";

export async function onRequest() {
  return new Response(obsoletePage(1), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}
