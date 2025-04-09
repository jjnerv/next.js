import type { NextApiResponse } from '../../types'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { RouteKind } from '../../server/route-kind'
import { sendError } from '../../server/api-utils'
import { getEdgePreviewProps } from '../../server/web/get-edge-preview-props'
import { PagesAPIRouteModule } from '../../server/route-modules/pages-api/module.compiled'
import path from 'node:path'
import { parse } from 'node:url'

import { hoist } from './helpers'

// Import the userland code.
import * as userland from 'VAR_USERLAND'
import { getTracer, SpanKind } from '../../server/lib/trace/tracer'
import { BaseServerSpan } from '../../server/lib/trace/constants'
import {
  ensureInstrumentationRegistered,
  instrumentationOnRequestError,
} from '../../server/lib/router-utils/instrumentation-globals'
import type { InstrumentationOnRequestError } from '../../server/instrumentation/types'
import { getUtils } from '../../server/server-utils'
import { ROUTES_MANIFEST } from '../../api/constants'
import { isDynamicRoute } from '../../shared/lib/router/utils'
import type { BaseNextRequest } from '../../server/base-http'
import {
  RouterServerContextSymbol,
  routerServerGlobal,
} from '../../server/lib/router-utils/router-server-context'
import { removePathPrefix } from '../../shared/lib/router/utils/remove-path-prefix'
import { normalizeLocalePath } from '../../shared/lib/i18n/normalize-locale-path'
import type { RoutesManifest } from '..'
import { normalizeNextQueryParam } from '../../server/web/utils'
import { decodeQueryPathParameter } from '../../server/lib/decode-query-path-parameter'

// Re-export the handler (should be the default export).
export default hoist(userland, 'default')

// Re-export config.
export const config = hoist(userland, 'config')

// Create and export the route module that will be consumed.
const routeModule = new PagesAPIRouteModule({
  definition: {
    kind: RouteKind.PAGES_API,
    page: 'VAR_DEFINITION_PAGE',
    pathname: 'VAR_DEFINITION_PATHNAME',
    // The following aren't used in production.
    bundlePath: '',
    filename: '',
  },
  userland,
})

export async function handler(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: {
    waitUntil?: (prom: Promise<void>) => void
  }
): Promise<void> {
  // we need to parse dynamic route params
  // and do URL normalization here
  const dir =
    routerServerGlobal[RouterServerContextSymbol]?.dir || process.cwd()
  const distDir = process.env.__NEXT_RELATIVE_DIST_DIR || ''
  const isDev = process.env.NODE_ENV === 'development'

  const routesManifest = (await (__non_webpack_require__ as typeof require)(
    path.join(dir, distDir, ROUTES_MANIFEST)
  )) as RoutesManifest
  const srcPage = 'VAR_DEFINITION_PAGE'
  const { basePath, i18n, rewrites } = routesManifest

  if (basePath) {
    req.url = removePathPrefix(req.url || '/', basePath)
  }

  if (i18n) {
    const urlParts = (req.url || '/').split('?')
    const localeResult = normalizeLocalePath(urlParts[0] || '/', i18n.locales)

    if (localeResult.detectedLocale) {
      req.url = `${localeResult.pathname}${
        urlParts[1] ? `?${urlParts[1]}` : ''
      }`
    }
  }

  const parsedUrl = parse(req.url || '/', true)
  const pageIsDynamic = isDynamicRoute(srcPage)

  const serverUtils = getUtils({
    page: srcPage,
    i18n,
    basePath,
    rewrites: Array.isArray(rewrites)
      ? { beforeFiles: [], afterFiles: rewrites, fallback: [] }
      : rewrites || {
          beforeFiles: [],
          afterFiles: [],
          fallback: [],
        },
    pageIsDynamic,
    trailingSlash: process.env.__NEXT_TRAILING_SLASH as any as boolean,
    caseSensitive: Boolean(routesManifest.caseSensitive),
  })
  const rewriteParamKeys = Object.keys(
    serverUtils.handleRewrites(req as any as BaseNextRequest, parsedUrl)
  )
  serverUtils.normalizeCdnUrl(req as any as BaseNextRequest, [
    ...rewriteParamKeys,
    ...Object.keys(serverUtils.defaultRouteRegex?.groups || {}),
  ])

  const params: Record<string, undefined | string | string[]> =
    serverUtils.dynamicRouteMatcher
      ? serverUtils.dynamicRouteMatcher(parsedUrl.pathname || '') || {}
      : {}

  const query = {
    ...parsedUrl.query,
    ...params,
  }
  // this is used to pass query information in rewrites
  // but should not be exposed in final query
  delete query['nextInternalLocale']

  for (const [key, value] of Object.entries(query)) {
    const normalizedKey = normalizeNextQueryParam(key)
    if (!normalizedKey) continue

    // Remove the prefixed key from the query params because we want
    // to consume it for the dynamic route matcher.
    delete query[key]

    if (typeof value === 'undefined') continue

    query[normalizedKey] = Array.isArray(value)
      ? value.map((v) => decodeQueryPathParameter(v))
      : decodeQueryPathParameter(value)
  }
  if (pageIsDynamic) {
    const result = serverUtils.normalizeDynamicRouteParams(query, true)

    if (result.hasValidParams) {
      Object.assign(query, result.params)
    }
  }

  // ensure instrumentation is registered and pass
  // onRequestError below
  const absoluteDistDir = path.join(dir, distDir)
  await ensureInstrumentationRegistered(absoluteDistDir)

  try {
    const method = req.method || 'GET'
    const tracer = getTracer()
    await tracer.trace(
      BaseServerSpan.handleRequest,
      {
        spanName: `${method} ${req.url}`,
        kind: SpanKind.SERVER,
        attributes: {
          'http.method': method,
          'http.target': req.url,
        },
      },
      async (span) => {
        await routeModule
          .render(req, res, {
            query,
            params,
            allowedRevalidateHeaderKeys: process.env
              .__NEXT_ALLOWED_REVALIDATE_HEADERS as any as string[],
            multiZoneDraftMode: Boolean(
              process.env.__NEXT_MULTI_ZONE_DRAFT_MODE
            ),
            trustHostHeader: process.env
              .__NEXT_TRUST_HOST_HEADER as any as boolean,
            previewProps: getEdgePreviewProps(),
            propagateError: false,
            dev: isDev,
            page: 'VAR_DEFINITION_PAGE',

            onError: (...args: Parameters<InstrumentationOnRequestError>) =>
              instrumentationOnRequestError(absoluteDistDir, ...args),
          })
          .finally(() => {
            if (!span) return

            span.setAttributes({
              'http.status_code': res.statusCode,
              'next.rsc': false,
            })

            const rootSpanAttributes = tracer.getRootSpanAttributes()
            // We were unable to get attributes, probably OTEL is not enabled
            if (!rootSpanAttributes) return

            if (
              rootSpanAttributes.get('next.span_type') !==
              BaseServerSpan.handleRequest
            ) {
              console.warn(
                `Unexpected root span type '${rootSpanAttributes.get(
                  'next.span_type'
                )}'. Please report this Next.js issue https://github.com/vercel/next.js`
              )
              return
            }

            const route = rootSpanAttributes.get('next.route')
            if (route) {
              const name = `${method} ${route}`

              span.setAttributes({
                'next.route': route,
                'http.route': route,
                'next.span_name': name,
              })
              span.updateName(name)
            } else {
              span.updateName(`${method} ${req.url}`)
            }
          })
      }
    )
  } catch (err) {
    // we re-throw in dev to show the error overlay
    if (isDev) {
      throw err
    }
    // this is technically an invariant as error handling
    // should be done inside of api-resolver onError
    sendError(res as NextApiResponse, 500, 'Internal Server Error')
  }
}
