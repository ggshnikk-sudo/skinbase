export async function onRequest(context) {
  const url = new URL(context.request.url);
  const id = url.searchParams.get('id');
  const location = id 
    ? `/api/v1/skin-file?id=${encodeURIComponent(id)}`
    : '/api/v1/skin-file';
  return new Response(null, {
    status: 301,
    headers: { 'Location': location }
  });
}
