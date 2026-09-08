// This file contains code that we reuse between our tests.
import * as path from 'node:path'
import * as test from 'node:test'
import helper from 'fastify-cli/helper.js'

export type TestContext = {
  after: typeof test.after
}

const AppPath = path.join(__dirname, '..', 'src', 'app.ts')

// Fill in this config with all the configurations
// needed for testing the application
function config () {
  return {
    skipOverride: true // Register our application with fastify-plugin
  }
}

// Automatically build and tear down our instance
async function build (t: TestContext) {
  // you can set all the options supported by the fastify CLI command
  const argv = [AppPath]

  // fastify-plugin ensures that all decorators
  // are exposed for testing purposes, this is
  // different from the production setup
  const app = await helper.build(argv, config())

  // Tear down our app after we are done. The promise is returned, not discarded: closing runs
  // asynchronous work now (the prefetch shutdown waits for whatever pass is in flight), and a
  // discarded promise lets the next test start, or this one's dispatcher and cache directory be
  // torn down, while the previous application is still stopping.
  t.after(() => app.close())

  return app
}

export {
  config,
  build
}
