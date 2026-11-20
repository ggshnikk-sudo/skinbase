export async function onRequest(context) {
  return new Response(null, {
    status: 308,
    headers: { 'Location': '/api/v1/register' }
  });
}
