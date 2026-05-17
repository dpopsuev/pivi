.PHONY: all fmt fmt-check lint lint-fix typecheck check fix install \
        fmt-lua fmt-check-lua lint-lua fmt-ts fmt-check-ts lint-ts

LUA_DIRS := lua/ plugin/
TS_FILES := extension.ts

# ── Install ───────────────────────────────────────────────────────────────

install:
	npm install
	@echo ""
	@echo "System tools required (install separately if missing):"
	@echo "  stylua  — cargo install stylua"
	@echo "  selene  — cargo install selene"

# ── Lua ───────────────────────────────────────────────────────────────────

fmt-lua:
	stylua $(LUA_DIRS)

fmt-check-lua:
	stylua --check $(LUA_DIRS)

lint-lua:
	selene $(LUA_DIRS)

# ── TypeScript ────────────────────────────────────────────────────────────

fmt-ts:
	npx @biomejs/biome format --write $(TS_FILES)

fmt-check-ts:
	npx @biomejs/biome format $(TS_FILES)  # exits 1 if diff

lint-ts:
	npx @biomejs/biome lint $(TS_FILES)

lint-fix-ts:
	npx @biomejs/biome lint --write $(TS_FILES)

typecheck:
	npx tsc --noEmit

# ── Combined ──────────────────────────────────────────────────────────────

fmt: fmt-lua fmt-ts

fmt-check: fmt-check-lua fmt-check-ts

lint: lint-lua lint-ts

lint-fix: fmt lint-fix-ts

## check — full CI gate: format check + lint + typecheck
check: fmt-check lint typecheck

## fix — auto-fix everything that can be auto-fixed
fix: fmt-lua fmt-ts lint-fix-ts

all: check
