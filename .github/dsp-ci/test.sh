#!/usr/bin/env bash
set -eu -o pipefail

export DSH_TEST_BUN_EXECUTABLE="${DSH_TEST_BUN_EXECUTABLE:-$(command -v bun)}"
test -x "$DSH_TEST_BUN_EXECUTABLE"
test -x /usr/bin/sandbox-exec

web_snapshot=apps/cli/tests/web-browser-open.expected.e2e.ts
case "${1:?expected ptc or web}" in
  ptc)
    test -s packages/ptc-runtime/ptc-runtime-node/lib/index.js
    test -s packages/ptc-runtime/ptc-runtime-node/lib/process.js
    test -s packages/ptc-runtime/ptc-runtime-node/lib/persistent-process.js
    test -s packages/workflow/workflow-ptc/lib/index.js
    unit=(packages/subprocess/subprocess/tests/{control,control-bun}.spec.ts
      packages/ptc-runtime/{ptc-runtime,ptc-runtime-node}/tests packages/workflow/workflow-ptc/tests)
    e2e=(packages/ptc-runtime/ptc-runtime-node/tests/built-bun.e2e.ts packages/workflow/workflow-ptc/tests/built-runtime.e2e.ts)
    # The workflow fixture registers this Cordis service dynamically.
    type_inputs=(packages/session/working-directory/lib/types/index.d.ts)
    ;;
  web)
    test -s apps/cli/lib/bin.js
    test -s apps/web/dist/index.html
    test -s packages/boot/hmr/lib/index.js
    test -s packages/boot/app-boot/lib/index.js
    unit=(packages/boot/app-boot/tests/package-meta.spec.ts packages/boot/hmr/tests/profile.spec.ts)
    e2e=(packages/boot/hmr/tests/built-bun.e2e.ts)
    type_inputs=("$web_snapshot" packages/boot/cmdline/lib/types/index.d.ts)
    ;;
  *) exit 2 ;;
esac

bun .github/dsp-ci/typecheck.mjs "${unit[@]}" "${e2e[@]}" "${type_inputs[@]}"
bun run vitest run --maxWorkers=1 "${unit[@]}"
bun run test:e2e --maxWorkers=1 "${e2e[@]}"
if [[ $1 == web ]]; then
  DSH_EXAMPLE_MODE=lib bun run test:expected --maxWorkers=1 "$web_snapshot"
  bun .github/dsp-ci/bun-web.mjs
fi
