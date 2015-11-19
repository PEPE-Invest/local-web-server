'use strict'
const path = require('path')
const url = require('url')

/**
 * @module local-web-server
 */
module.exports = localWebServer

/**
 * Returns a Koa application you can launch or mix into an existing app.
 *
 * @param [options] {object} - options
 * @param [options.static] {object} - koa-static config
 * @param [options.static.root=.] {string} - root directory
 * @param [options.static.options] {string} - [options](https://github.com/koajs/static#options)
 * @param [options.serveIndex] {object} - koa-serve-index config
 * @param [options.serveIndex.path=.] {string} - root directory
 * @param [options.serveIndex.options] {string} - [options](https://github.com/expressjs/serve-index#options)
 * @param [options.forbid] {string[]} - A list of forbidden routes, each route being an [express route-path](http://expressjs.com/guide/routing.html#route-paths).
 * @param [options.spa] {string} - specify an SPA file to catch requests for everything but static assets.
 * @param [options.log] {object} - [morgan](https://github.com/expressjs/morgan) config
 * @param [options.log.format] {string} - [log format](https://github.com/expressjs/morgan#predefined-formats)
 * @param [options.log.options] {object} - [options](https://github.com/expressjs/morgan#options)
 * @param [options.compress] {boolean} - Serve gzip-compressed resources, where applicable
 * @param [options.mime] {object} - A list of mime-type overrides, passed directly to [mime.define()](https://github.com/broofa/node-mime#mimedefine)
 * @param [options.rewrite] {module:local-web-server~rewriteRule[]} - One or more rewrite rules
 * @param [options.verbose] {boolean} - Print detailed output, useful for debugging
 *
 * @alias module:local-web-server
 * @return {external:KoaApplication}
 * @example
 * const localWebServer = require('local-web-server')
 * localWebServer().listen(8000)
 */
function localWebServer (options) {
  options = Object.assign({
    static: {},
    serveIndex: {},
    spa: null,
    log: {},
    compress: false,
    mime: {},
    forbid: [],
    rewrite: [],
    verbose: false
  }, options)

  if (options.verbose) {
    process.env.DEBUG = '*'
  }

  const debug = require('debug')('local-web-server')
  const Koa = require('koa')
  const convert = require('koa-convert')
  const cors = require('kcors')
  const _ = require('koa-route')
  const json = require('koa-json')
  const bodyParser = require('koa-bodyparser')
  const mw = require('./middleware')

  const log = options.log
  log.options = log.options || {}

  const app = new Koa()
  const _use = app.use
  app.use = x => _use.call(app, convert(x))

  if (options.verbose && !log.format) {
    log.format = 'none'
  }

  /* CORS: allow from any origin */
  app.use(cors())

  /* pretty print JSON */
  app.use(json())

  /* request body parser */
  app.use(bodyParser())

  /* rewrite rules */
  if (options.rewrite && options.rewrite.length) {
    options.rewrite.forEach(route => {
      if (route.to) {
        if (url.parse(route.to).host) {
          debug('proxy rewrite', `${route.from} -> ${route.to}`)
          app.use(_.all(route.from, mw.proxyRequest(route, app)))
        } else {
          const rewrite = require('koa-rewrite')
          const rmw = rewrite(route.from, route.to)
          rmw._name = 'rewrite'
          app.use(rmw)
        }
      }
    })
  }

  /* path blacklist */
  if (options.forbid.length) {
    debug('forbid', options.forbid.join(', '))
    app.use(mw.blacklist(options.forbid))
  }

  /* Cache */
  if (!options['no-cache']) {
    const conditional = require('koa-conditional-get')
    const etag = require('koa-etag')
    app.use(conditional())
    app.use(etag())
  }

  /* mime-type overrides */
  if (options.mime) {
    debug('mime override', JSON.stringify(options.mime))
    app.use(mw.mime(options.mime))
  }

  /* compress response */
  if (options.compress) {
    const compress = require('koa-compress')
    debug('compression', 'enabled')
    app.use(compress())
  }

  /* Logging */
  if (log.format !== 'none') {
    const morgan = require('koa-morgan')

    if (!log.format) {
      const streamLogStats = require('stream-log-stats')
      log.options.stream = streamLogStats({ refreshRate: 500 })
      app.use(morgan.middleware('common', log.options))
    } else if (log.format === 'logstalgia') {
      morgan.token('date', logstalgiaDate)
      app.use(morgan.middleware('combined', log.options))
    } else {
      app.use(morgan.middleware(log.format, log.options))
    }
  }

  /* Mock Responses */
  app.use(mw.mockResponses({ root: options.static.root }))

  /* serve static files */
  if (options.static.root) {
    const serve = require('koa-static')
    app.use(serve(options.static.root, options.static.options))
  }

  /* serve directory index */
  if (options.serveIndex.path) {
    const serveIndex = require('koa-serve-index')
    app.use(serveIndex(options.serveIndex.path, options.serveIndex.options))
  }

  /* for any URL not matched by static (e.g. `/search`), serve the SPA */
  if (options.spa) {
    const send = require('koa-send')
    debug('SPA', options.spa)
    app.use(_.all('*', function * () {
      yield send(this, options.spa, { root: path.resolve(options.static.root) || process.cwd() })
    }))
  }
  return app
}

function logstalgiaDate () {
  var d = new Date()
  return (`${d.getDate()}/${d.getUTCMonth()}/${d.getFullYear()}:${d.toTimeString()}`).replace('GMT', '').replace(' (BST)', '')
}

process.on('unhandledRejection', (reason, p) => {
  throw reason
})

/**
 * The `from` and `to` routes are specified using [express route-paths](http://expressjs.com/guide/routing.html#route-paths)
 *
 * @example
 * ```json
 * {
 *   "rewrite": [
 *     { "from": "/css/*", "to": "/build/styles/$1" },
 *     { "from": "/npm/*", "to": "http://registry.npmjs.org/$1" },
 *     { "from": "/:user/repos/:name", "to": "https://api.github.com/repos/:user/:name" }
 *   ]
 * }
 * ```
 *
 * @typedef rewriteRule
 * @property from {string} - request route
 * @property to {string} - target route
 */

/**
 * @external KoaApplication
 * @see https://github.com/koajs/koa/blob/master/docs/api/index.md#application
 */