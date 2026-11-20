export async function onRequest(context) {
  const url = new URL(context.request.url);
  return new Response(null, {
    status: 308,
    headers: { 'Location': `/api/v1/skins${url.search}` }
  });
}
