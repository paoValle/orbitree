# Every target here is a thin wrapper over a `pnpm` script, so the same commands
# work on Windows where `make` is often absent. CI runs the pnpm scripts directly.
.DEFAULT_GOAL := help
.PHONY: help setup build test coverage mutate lint fmt fmt-check typecheck verify prove verify-invariants check clean cli desktop e2e perf gifs

help: ## show this help
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

setup: ## install dependencies from the lockfile
	pnpm install --frozen-lockfile
	@# pnpm links Electron but never runs the postinstall that downloads the ~100 MB Chromium
	@# binary, on a clean install with side-effects caching off and the script allowed. A fresh
	@# clone would then fail at `make desktop` with an error that names nothing useful, so it is
	@# run here, where it is explicit and idempotent.
	node apps/desktop/node_modules/electron/install.js

build: ## build every package
	pnpm run build

test: ## full test suite
	pnpm run test

coverage: ## tests with coverage
	pnpm run coverage

mutate: ## mutation testing on packages/core (slow, the anti-tautology gate)
	pnpm run mutate

lint: ## lint, warnings are errors
	pnpm run lint

fmt: ## writes formatting
	pnpm run fmt

fmt-check: ## checks formatting without writing
	pnpm run fmt:check

typecheck: ## the compiler is the first invariant
	pnpm run typecheck

verify-invariants: ## every claimed invariant has a test, and every tagged test an invariant
	./bin/check-invariants.sh

prove: ## re-measures the numbers the README claims, from real runs
	./bin/prove.sh

verify: fmt-check lint typecheck verify-invariants test ## exactly what CI runs on a pull request
check: verify ## alias

cli: ## run the CLI against the current directory
	./bin/orbitree status .

desktop: ## run the desktop app against this repository
	@test -f apps/desktop/node_modules/electron/path.txt || \
		{ echo "the Electron binary is missing: run 'make setup' first" >&2; exit 1; }
	pnpm run desktop:dev

e2e: ## run the fast UI tests on the real window (reports/e2e.log, and e2e-failure.log on a failure)
	@mkdir -p reports
	@# The target keeps the log rather than the caller. Four times a flaky test failed while the
	@# output was piped into grep, and each time the evidence was gone before it could be read. A
	@# failing run also keeps a copy, so the next run cannot overwrite the thing being diagnosed.
	@pnpm --filter @orbitree/desktop run e2e > reports/e2e.log 2>&1; status=$$?; \
		if [ $$status -ne 0 ]; then cp reports/e2e.log reports/e2e-failure.log; fi; \
		tail -25 reports/e2e.log; exit $$status

perf: ## measure the UI on a large repository
	pnpm --filter @orbitree/desktop run e2e:perf

gifs: ## rebuild the README's GIFs from the product (needs ffmpeg, writes docs/media)
	./bin/make-gifs.sh

clean: ## remove build output
	rm -rf node_modules packages/*/node_modules apps/*/node_modules packages/*/dist apps/*/out coverage reports .tmp
