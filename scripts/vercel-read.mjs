export async function vercelJson(path, token, label, request = fetch) {
  const response = await request(`https://api.vercel.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    // Never include the token, headers, URL response body, or error message in Actions logs.
    throw new Error(`Vercel ${label} read returned HTTP ${response.status}`);
  }
  return response.json();
}
