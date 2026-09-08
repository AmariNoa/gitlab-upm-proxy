import { join } from 'node:path'
import AutoLoad, { AutoloadPluginOptions } from '@fastify/autoload'
import { FastifyPluginAsync, FastifyServerOptions } from 'fastify'
import "dotenv/config";
import { startVpmPrefetch } from "./lib/vpm-prefetch";


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
  startVpmPrefetch(fastify.log);

  // Do not touch the following lines

  // This loads all plugins defined in plugins
  // those should be support plugins that are reused
  // through your application
  // eslint-disable-next-line no-void
  void fastify.register(AutoLoad, {
    dir: join(__dirname, 'plugins'),
    options: opts
  })

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
