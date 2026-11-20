import { obsoleteJson } from "../../../_lib/obsolete.js";

export async function onRequest() {
  return obsoleteJson();
}
