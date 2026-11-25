/** Finish all outputs for one workspace before starting the next one. */
import { build } from 'tsdown'

const [face, ...directories] = process.argv.slice(2)
for (const directory of directories) {
  try {
    await build({ config: 'tsdown.config.ts', configLoader: 'native', workspace: { include: [directory] }, env: { DSH_BUILD_FACE: face } })
  } catch (error) {
    // Some projects contribute types on both faces but only emit bundles on one.
    if (!(error instanceof Error) || error.message !== 'No valid configuration found.') throw error
  }
}
