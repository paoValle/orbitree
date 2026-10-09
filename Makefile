# Every target here is a thin wrapper over a `pnpm` script, so the same commands
# work on Windows where `make` is often absent. CI runs the pnpm scripts directly.
.DEFAULT_GOAL := help
.PHONY: help setup build test coverage mutate lint fmt fmt-check typecheck verify prove verify-invariants check clean cli desktop

help: ## show this help
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

setup: ## install dependencies from the lockfile
	pnpm install --frozen-lockfile

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
	./bin/keplerk status .

desktop: ## run the desktop app against this repository
	pnpm run desktop:dev

clean: ## remove build output
	rm -rf node_modules packages/*/node_modules apps/*/node_modules packages/*/dist apps/*/out coverage reports .tmp
