export async function onRequest(context) {
  const { request, params } = context;
  const search = new URL(request.url).search;
  return new Response(null, {
    status: 308,
    headers: { 'Location': `/api/v1/skins/${params.id}${search}` }
  });
}