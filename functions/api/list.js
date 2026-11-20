export async function onRequest(context) {
  return new Response(null, {
    status: 301,
    headers: { 'Location': '/api/v1/list' }
  });
}
