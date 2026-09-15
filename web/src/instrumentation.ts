export async function register() {
  // Only run in Node.js runtime (not Edge)
  if (typeof (globalThis as Record<string, unknown>).EdgeRuntime !== 'undefined') return;

  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY;

  if (!proxy) return;

  try {
    // Use eval to prevent Webpack from statically analyzing and bundling undici
    // (it imports `node:` URIs, which the instrumentation bundle cannot handle).
    // Hiding it from Webpack also hides it from Next's file tracing, so
    // next.config.ts copies undici into the standalone output explicitly.
    // eslint-disable-next-line no-eval
    const undici = eval('require')('undici') as typeof import('undici');
    undici.setGlobalDispatcher(new undici.ProxyAgent(proxy));
    console.log(`[instrumentation] Setting global proxy dispatcher: ${proxy}`);
  } catch (error) {
    // Routing through a proxy is a convenience. Failing to do so must not take
    // the server down with it: this threw on startup in the packaged app and
    // turned every request into a 500 for anyone who had a proxy configured.
    console.error('[instrumentation] Proxy dispatcher not installed:', error);
  }
}
