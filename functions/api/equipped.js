export async function onRequest(context) {
  const url = new URL(context.request.url);
  const username = url.searchParams.get('username');
  const location = username 
    ? `/api/v1/equipped?username=${encodeURIComponent(username)}`
    : '/api/v1/equipped';
  return new Response(null, {
    status: 301,
    headers: { 'Location': location }
  });
}
