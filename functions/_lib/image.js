const DIRECT_IBB = /^https:\/\/i\.ibb\.co\//;
const DIRECT_HOSTS = new Set(['i.ibb.co', 'i.imgur.com', 'cdn.discordapp.com', 'media.discordapp.net']);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|jfif|avif)([?#].*)?$/i;
const OG_IMAGE_TAG = /<meta[^>]*(?:property|name)\s*=\s*["']og:image["'][^>]*>/i;
const OG_IMAGE_CONTENT = /content\s*=\s*["']([^"']+)["']/i;

export async function resolveImageUrl(value) {
  if (!value) return value;

  let url;
  try {
    url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return value;
  } catch {
    return value;
  }

  if (DIRECT_IBB.test(value)) return value;
  if (DIRECT_HOSTS.has(url.hostname)) return value;
  if (IMAGE_EXT.test(url.pathname)) return value;

  try {
    const res = await fetch(value, { cf: { cacheTtl: 3600, cacheEverything: true } });
    const contentType = res.headers.get('Content-Type') || '';

    if (contentType.startsWith('image/')) return value;

    if (contentType.includes('html') || contentType.includes('text')) {
      const html = await res.text();
      const tag = html.match(OG_IMAGE_TAG);
      const og = tag ? tag[0].match(OG_IMAGE_CONTENT) : null;
      if (og && og[1]) {
        try {
          return new URL(og[1], value).href;
        } catch {
          return og[1];
        }
      }
    }
  } catch {}

  return value;
}
