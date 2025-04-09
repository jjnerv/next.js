import path from 'node:path'
import isError from '../../../lib/is-error'
import { INSTRUMENTATION_HOOK_FILENAME } from '../../../lib/constants'
import type {
  InstrumentationModule,
  InstrumentationOnRequestError,
} from '../../instrumentation/types'

export async function getInstrumentationModule(
  distDir: string
): Promise<InstrumentationModule | undefined> {
  try {
    // TODO: import this in template files instead?
    return await (__non_webpack_require__ as typeof require)(
      path.join(distDir, 'server', `${INSTRUMENTATION_HOOK_FILENAME}.js`)
    )
  } catch (err: unknown) {
    if (
      isError(err) &&
      err.code !== 'ENOENT' &&
      err.code !== 'MODULE_NOT_FOUND'
    ) {
      throw err
    }
  }
}

let instrumentationModulePromise: Promise<any> | null = null
async function registerInstrumentation(distDir: string) {
  // Ensure registerInstrumentation is not called in production build
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  if (!instrumentationModulePromise) {
    instrumentationModulePromise = getInstrumentationModule(distDir)
  }
  const instrumentation = await instrumentationModulePromise
  if (instrumentation?.register) {
    try {
      await instrumentation.register()
    } catch (err: any) {
      err.message = `An error occurred while loading instrumentation hook: ${err.message}`
      throw err
    }
  }
}

export async function instrumentationOnRequestError(
  distDir: string,
  ...args: Parameters<InstrumentationOnRequestError>
) {
  const instrumentation = await getInstrumentationModule(distDir)
  try {
    await instrumentation?.onRequestError?.(...args)
  } catch (err) {
    // Log the soft error and continue, since the original error has already been thrown
    console.error('Error in instrumentation.onRequestError:', err)
  }
}

let registerInstrumentationPromise: Promise<void> | null = null
export function ensureInstrumentationRegistered(distDir: string) {
  if (!registerInstrumentationPromise) {
    registerInstrumentationPromise = registerInstrumentation(distDir)
  }
  return registerInstrumentationPromise
}
