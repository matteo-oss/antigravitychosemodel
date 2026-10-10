/** Preserve provider-specific prefixes such as /inference/v1 and /openai/v1. */
export function providerUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Provider URL must use HTTP(S) without embedded credentials');
  }
  url.hash = '';
  return url;
}

export function openAIEndpoint(baseUrl: string, endpoint: 'models' | 'chat/completions'): string {
  const url = providerUrl(baseUrl);
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/, '');
  if (!/\/v\d+(?:beta)?(?:\/|$)/.test(path)) path += '/v1';
  url.pathname = `${path}/${endpoint}`;
  return url.toString();
}
