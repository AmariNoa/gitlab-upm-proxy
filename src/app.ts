import { existsSync } from 'node:fs'
import { join } from 'node:path'
import AutoLoad, { AutoloadPluginOptions } from '@fastify/autoload'
import { FastifyPluginAsync, FastifyServerOptions } from 'fastify'
import "dotenv/config";
import { createPrefetchLifecycle, startVpmPrefetch, stopVpmPrefetch } from "./lib/vpm-prefetch";
import { validateDownloadLimits, validateUpstreamBodyLimit } from "./lib/http";
import { validateExtractLimits } from "./lib/tgz";


export interface AppOptions extends FastifyServerOptions, Partial<AutoloadPluginOptions> {

}
// Pass --options via CLI arguments in command to enable these options.
const options: AppOptions = {
  logger: {
    serializers: {
      // Fastify's own request log prints req.url, and tarball URLs carry the query the
      // upstream signed them with - which this proxy deliberately preserves end to end. The
      // path alone is what belongs in a log; the signature is a credential.
      req(request: any) {
        const url = typeof request?.url === "string" ? request.url : "";
        const queryStart = url.indexOf("?");
        return {
          method: request?.method,
          path: queryStart < 0 ? url : url.slice(0, queryStart),
          host: request?.host,
          remoteAddress: request?.ip
        };
      }
    }
  }
}

const app: FastifyPluginAsync<AppOptions> = async (
  fastify,
  opts
): Promise<void> => {
  // Place here your custom code!
  //
  // The archive limits are otherwise only read when an archive is downloaded or expanded, so a
  // typo in one of them stayed invisible until then. Reading them here makes a malformed value
  // stop the server, which is what an operator expects a configuration error to do.
  validateDownloadLimits();
  validateUpstreamBodyLimit();
  validateExtractLimits();

  //
  // One lifecycle per server, decorated onto the instance so the routes can hand it to the
  // request-triggered prefetch. Keeping it in the module instead meant closing one server
  // stopped another built in the same process, and starting the second cleared the first's stop.
  const prefetchLifecycle = createPrefetchLifecycle();
  fastify.decorate("vpmPrefetchLifecycle", prefetchLifecycle);
  startVpmPrefetch(fastify.log, prefetchLifecycle);

  // Nothing awaits the prefetch, so without this a closed server kept downloading archives and
  // writing them into a cache directory the process was finished with. Closing now stops it and
  // waits for whatever critical section it is inside, so publication is never abandoned midway.
  fastify.addHook("onClose", async () => {
    await stopVpmPrefetch(prefetchLifecycle);
  });

  // Do not touch the following lines

  // This loads all plugins defined in plugins
  // those should be support plugins that are reused
  // through your application
  //
  // Guarded because the directory is currently empty: the only tracked entry is a .gitkeep, which
  // tsc does not emit, so a clean build has no dist/plugins at all and AutoLoad throws on a
  // missing directory. Deployment used to paper over that with a manual mkdir in the README.
  const pluginsDir = join(__dirname, 'plugins')
  if (existsSync(pluginsDir)) {
    // eslint-disable-next-line no-void
    void fastify.register(AutoLoad, {
      dir: pluginsDir,
      options: opts
    })
  }

  // This loads all plugins defined in routes
  // define your routes in one of these
  // eslint-disable-next-line no-void
  void fastify.register(AutoLoad, {
    dir: join(__dirname, 'routes'),
    options: opts
  })
}

export default app
export { app, options }
